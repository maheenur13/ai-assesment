import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ALICE, bearer, createTestContext, productIdBySku, resetDb } from '../helpers/app.js';

const { app, db } = createTestContext();
const alice = bearer(ALICE);

beforeEach(() => resetDb(db));
afterAll(() => db.$disconnect());

function placeOrder(items: unknown, key: string = randomUUID()) {
  return request(app).post('/api/v1/orders').set(alice).set('Idempotency-Key', key).send({ items });
}

async function stockOf(sku: string): Promise<number> {
  return (await db.product.findUniqueOrThrow({ where: { sku } })).stock;
}

describe('POST /api/v1/orders', () => {
  it('places an order: server-side pricing, snapshots, stock decrement, 201 + Location', async () => {
    const headphones = await productIdBySku(db, 'AUD-HP-001');
    const cable = await productIdBySku(db, 'PHN-CB-004');
    const res = await placeOrder([
      { productId: headphones, quantity: 2 },
      { productId: cable, quantity: 3 },
    ]).expect(201);

    expect(res.headers['location']).toBe(`/api/v1/orders/${res.body.id}`);
    expect(res.body.total).toEqual({ amount: 2 * 12999 + 3 * 1299, currency: 'USD' });
    expect(res.body.items).toContainEqual(
      expect.objectContaining({ productName: 'Aurora Wireless Headphones', quantity: 2 }),
    );
    expect(await stockOf('AUD-HP-001')).toBe(23);
    expect(await stockOf('PHN-CB-004')).toBe(197);
  });

  it('keeps historical prices when the catalog price changes later', async () => {
    const id = await productIdBySku(db, 'AUD-SP-003');
    const order = await placeOrder([{ productId: id, quantity: 1 }]).expect(201);
    await db.product.update({ where: { id }, data: { priceCents: 1 } });
    const res = await request(app).get(`/api/v1/orders/${order.body.id}`).set(alice).expect(200);
    expect(res.body.items[0].unitPrice.amount).toBe(3499);
  });

  it('rejects insufficient stock with 409 and changes nothing (atomic)', async () => {
    const thermostat = await productIdBySku(db, 'HOM-TH-004'); // stock 4
    const cable = await productIdBySku(db, 'PHN-CB-004');
    const res = await placeOrder([
      { productId: cable, quantity: 1 },
      { productId: thermostat, quantity: 5 },
    ]).expect(409);
    expect(res.body).toMatchObject({ type: '/problems/insufficient-stock', productId: thermostat });
    expect(await stockOf('PHN-CB-004')).toBe(200);
    expect(await db.order.count()).toBe(3); // seeded orders only
  });

  it('rejects out-of-stock, inactive and unknown products with 422', async () => {
    const ssd = await productIdBySku(db, 'CMP-SSD-005'); // stock 0 → 409
    await placeOrder([{ productId: ssd, quantity: 1 }]).expect(409);

    const legacy = await productIdBySku(db, 'LEG-MP3-001'); // inactive
    const res = await placeOrder([
      { productId: legacy, quantity: 1 },
      { productId: '7d1f0c1e-0000-4000-8000-000000000000', quantity: 1 },
    ]).expect(422);
    expect(res.body.errors.map((e: { pointer: string }) => e.pointer)).toEqual([
      '#/body/items/0/productId',
      '#/body/items/1/productId',
    ]);
  });

  it.each([
    ['empty order', []],
    ['zero quantity', [{ productId: randomUUID(), quantity: 0 }]],
    ['negative quantity', [{ productId: randomUUID(), quantity: -2 }]],
    ['fractional quantity', [{ productId: randomUUID(), quantity: 1.5 }]],
    ['quantity over the per-line cap', [{ productId: randomUUID(), quantity: 101 }]],
    ['non-uuid product id', [{ productId: '1; DROP TABLE products', quantity: 1 }]],
  ])('rejects %s with 422', async (_label, items) => {
    await placeOrder(items).expect(422);
  });

  it('rejects the same product twice in one order', async () => {
    const id = await productIdBySku(db, 'AUD-HP-001');
    await placeOrder([
      { productId: id, quantity: 1 },
      { productId: id, quantity: 1 },
    ]).expect(422);
  });

  it('prevents overselling under concurrent orders', async () => {
    const thermostat = await productIdBySku(db, 'HOM-TH-004'); // stock 4
    const results = await Promise.all(
      Array.from({ length: 6 }, () => placeOrder([{ productId: thermostat, quantity: 1 }])),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(4);
    expect(statuses.filter((s) => s === 409)).toHaveLength(2);
    expect(await stockOf('HOM-TH-004')).toBe(0);
  });
});

describe('Idempotency-Key', () => {
  it('is required', async () => {
    const id = await productIdBySku(db, 'AUD-HP-001');
    const res = await request(app)
      .post('/api/v1/orders')
      .set(alice)
      .send({ items: [{ productId: id, quantity: 1 }] })
      .expect(400);
    expect(res.body.detail).toContain('Idempotency-Key');
  });

  it('replays the original response for a retried request (one order, one decrement)', async () => {
    const id = await productIdBySku(db, 'AUD-HP-001');
    const key = randomUUID();
    const first = await placeOrder([{ productId: id, quantity: 1 }], key).expect(201);
    const second = await placeOrder([{ productId: id, quantity: 1 }], key).expect(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(await stockOf('AUD-HP-001')).toBe(24);
  });

  it('rejects reuse of a key with a different body (422)', async () => {
    const id = await productIdBySku(db, 'AUD-HP-001');
    const key = randomUUID();
    await placeOrder([{ productId: id, quantity: 1 }], key).expect(201);
    const res = await placeOrder([{ productId: id, quantity: 2 }], key).expect(422);
    expect(res.body.errors[0].pointer).toBe('#/headers/idempotency-key');
  });

  it('collapses concurrent duplicates into a single order', async () => {
    const id = await productIdBySku(db, 'AUD-HP-001');
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => placeOrder([{ productId: id, quantity: 1 }], key)),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await stockOf('AUD-HP-001')).toBe(24);
  });

  it('allows a retry with the same key after a failed (409) attempt', async () => {
    const id = await productIdBySku(db, 'HOM-TH-004');
    const key = randomUUID();
    await placeOrder([{ productId: id, quantity: 5 }], key).expect(409);
    await db.product.update({ where: { id }, data: { stock: 10 } });
    await placeOrder([{ productId: id, quantity: 5 }], key).expect(201);
  });
});

describe('GET /api/v1/orders', () => {
  it("lists the caller's orders newest first with pagination", async () => {
    const page1 = await request(app).get('/api/v1/orders?limit=1').set(alice).expect(200);
    expect(page1.body.data).toHaveLength(1);
    expect(page1.body.nextCursor).toBeDefined();
    const page2 = await request(app)
      .get(`/api/v1/orders?limit=1&cursor=${page1.body.nextCursor}`)
      .set(alice)
      .expect(200);
    expect(page2.body.data[0].id).not.toBe(page1.body.data[0].id);
    expect(page2.body.nextCursor).toBeUndefined();
  });
});
