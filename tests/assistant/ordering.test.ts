import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ALICE,
  ALICE_ORDER_ID,
  bearer,
  createTestContext,
  productIdBySku,
  proposeViaChat,
  resetDb,
} from '../helpers/app.js';
import { callTool, FakeLlm, say } from '../helpers/fake-llm.js';

const llm = new FakeLlm();
const { app, db } = createTestContext({}, llm);
const chatAs = (token: string, body: object) =>
  request(app).post('/api/v1/chat').set(bearer(token)).send(body);

beforeEach(() => resetDb(db));
afterAll(() => db.$disconnect());

const stockOf = async (sku: string) =>
  (await db.product.findUniqueOrThrow({ where: { sku } })).stock;

describe('assistant: checking orders', () => {
  it("lists the customer's own orders, newest first, with totals", async () => {
    llm.script(callTool('list_my_orders', {}), say('You have 2 orders.'));
    await chatAs(ALICE, { message: 'What did I order?' }).expect(200);
    const [result] = llm.toolResults() as [{ orders: { id: string; total: string }[] }];
    expect(result.orders).toHaveLength(2);
    expect(result.orders[1]).toMatchObject({ id: ALICE_ORDER_ID, total: '155.97 USD' });
  });

  it('gets one order with its items', async () => {
    llm.script(callTool('get_my_order', { id: ALICE_ORDER_ID }), say('ok'));
    await chatAs(ALICE, { message: `Status of ${ALICE_ORDER_ID}?` }).expect(200);
    const [result] = llm.toolResults() as [{ order: { status: string; items: unknown[] } }];
    expect(result.order.status).toBe('placed');
    expect(result.order.items).toContainEqual({
      productName: 'Aurora Wireless Headphones',
      quantity: 1,
      unitPrice: '129.99 USD',
      lineTotal: '129.99 USD',
    });
  });
});

describe('assistant: placing an order (propose, then confirm)', () => {
  it('proposes with server-side prices and places nothing yet', async () => {
    const headphones = await productIdBySku(db, 'AUD-HP-001');
    llm.script(
      callTool('propose_order', { items: [{ productId: headphones, quantity: 2 }] }),
      say('2 × Aurora Wireless Headphones, 259.98 USD. Confirm?'),
    );
    const res = await chatAs(ALICE, { message: 'Order 2 Aurora headphones' }).expect(200);

    expect(res.body.proposal).toMatchObject({
      status: 'pending',
      total: { amount: 25998, currency: 'USD' },
      items: [{ productId: headphones, quantity: 2, unitPrice: { amount: 12999 } }],
    });
    expect(res.body.order).toBeUndefined();
    const [result] = llm.toolResults() as [{ proposal: { total: string } }];
    expect(result.proposal.total).toBe('259.98 USD');
    expect(await stockOf('AUD-HP-001')).toBe(25);
    expect(await db.order.count()).toBe(3); // the seeded orders only
  });

  it('places the order when the customer confirms in the next message', async () => {
    const headphones = await productIdBySku(db, 'AUD-HP-001');
    const { conversationId, proposalId } = await proposeViaChat(app, llm, ALICE, [
      { productId: headphones, quantity: 2 },
    ]);

    llm.script(callTool('confirm_order', { proposalId }), say('Done! Your order is placed.'));
    const res = await chatAs(ALICE, { conversationId, message: 'Yes, place it' }).expect(200);

    expect(res.body.order).toMatchObject({ status: 'placed', total: { amount: 25998 } });
    expect(await stockOf('AUD-HP-001')).toBe(23);
    const proposal = await db.orderProposal.findUniqueOrThrow({ where: { id: proposalId } });
    expect(proposal).toMatchObject({ status: 'placed', orderId: res.body.order.id });
  });

  it('places the order through the confirm endpoint, once, however often it is called', async () => {
    const speaker = await productIdBySku(db, 'AUD-SP-003');
    const { proposalId } = await proposeViaChat(app, llm, ALICE, [
      { productId: speaker, quantity: 1 },
    ]);
    const confirm = () =>
      request(app).post(`/api/v1/order-proposals/${proposalId}/confirm`).set(bearer(ALICE));

    const first = await confirm().expect(201);
    expect(first.headers['location']).toBe(`/api/v1/orders/${first.body.id}`);
    expect(first.body.total).toEqual({ amount: 3499, currency: 'USD' });

    const again = await confirm().expect(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.id).toBe(first.body.id);
    expect(await stockOf('AUD-SP-003')).toBe(39);
    expect(await db.order.count({ where: { customer: { email: 'alice@example.com' } } })).toBe(3);
  });

  it('reports insufficient stock to the model instead of proposing', async () => {
    const thermostat = await productIdBySku(db, 'HOM-TH-004'); // stock 4
    llm.script(
      callTool('propose_order', { items: [{ productId: thermostat, quantity: 5 }] }),
      say('Only 4 left.'),
    );
    const res = await chatAs(ALICE, { message: '5 thermostats' }).expect(200);
    expect(llm.toolResults()).toEqual([
      expect.objectContaining({ error: 'Insufficient stock', available: 4 }),
    ]);
    expect(res.body.proposal).toBeUndefined();
    expect(await db.orderProposal.count()).toBe(0);
  });
});

describe('assistant: guest checkout (no token)', () => {
  const guestTurn = (body: object) => request(app).post('/api/v1/chat').send(body);

  async function guestProposal() {
    const cable = await productIdBySku(db, 'PHN-CB-004');
    llm.script(
      callTool('set_guest_details', { name: 'Gina Guest', email: 'Gina@Example.com' }),
      callTool('propose_order', { items: [{ productId: cable, quantity: 2 }] }),
      say('2 cables, 25.98 USD. Confirm?'),
    );
    const res = await guestTurn({ message: "I'm Gina, gina@example.com, 2 USB-C cables" }).expect(
      200,
    );
    return res.body as { conversationId: string; proposal: { id: string; total: unknown } };
  }

  it('saves the guest, proposes, and places the order when the guest says yes', async () => {
    const { conversationId, proposal } = await guestProposal();
    expect(proposal.total).toEqual({ amount: 2598, currency: 'USD' });
    const guest = await db.customer.findFirstOrThrow({ where: { isGuest: true } });
    expect(guest).toMatchObject({ name: 'Gina Guest', email: 'gina@example.com', tokenHash: null });

    llm.script(callTool('confirm_order', { proposalId: proposal.id }), say('Placed!'));
    const res = await guestTurn({ conversationId, message: 'yes' }).expect(200);
    expect(res.body.order).toMatchObject({ total: { amount: 2598 } });
    expect(await db.order.count({ where: { customerId: guest.id } })).toBe(1);
    expect(await stockOf('PHN-CB-004')).toBe(198);
  });

  it('places the order from the Confirm button with the conversation id, once', async () => {
    const { conversationId, proposal } = await guestProposal();
    const confirm = () =>
      request(app).post(`/api/v1/order-proposals/${proposal.id}/confirm`).send({ conversationId });
    const first = await confirm().expect(201);
    const again = await confirm().expect(201);
    expect(again.body.id).toBe(first.body.id);
    expect(await stockOf('PHN-CB-004')).toBe(198);
  });

  it("lists only the orders placed in this guest's conversation", async () => {
    const { conversationId, proposal } = await guestProposal();
    await request(app)
      .post(`/api/v1/order-proposals/${proposal.id}/confirm`)
      .send({ conversationId })
      .expect(201);
    llm.script(callTool('list_my_orders', {}), say('1 order'));
    await guestTurn({ conversationId, message: 'my orders?' }).expect(200);
    const result = llm.toolResults().at(-1) as { orders: { total: string }[] };
    expect(result.orders).toEqual([expect.objectContaining({ total: '25.98 USD' })]);
  });

  it('updates the same guest when details are corrected, instead of creating another', async () => {
    const { conversationId } = await guestProposal();
    llm.script(
      callTool('set_guest_details', { name: 'Gina G.', email: 'gina.g@example.com' }),
      say('Updated.'),
    );
    await guestTurn({ conversationId, message: 'my email is gina.g@example.com' }).expect(200);
    const guests = await db.customer.findMany({ where: { isGuest: true } });
    expect(guests).toHaveLength(1);
    expect(guests[0]).toMatchObject({ name: 'Gina G.', email: 'gina.g@example.com' });
  });
});
