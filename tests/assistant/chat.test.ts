import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { LlmError } from '../../server/src/assistant/llm.js';
import { SYSTEM_PROMPT, trimHistory } from '../../server/src/assistant/service.js';
import { ALICE, bearer, createTestContext, productIdBySku, resetDb } from '../helpers/app.js';
import { callTool, FakeLlm, say } from '../helpers/fake-llm.js';

const llm = new FakeLlm();
const { app, db } = createTestContext({}, llm);
const chat = (body: unknown) =>
  request(app)
    .post('/api/v1/chat')
    .send(body as object);

beforeEach(() => resetDb(db));
afterAll(() => db.$disconnect());

describe('POST /api/v1/chat — catalog answers', () => {
  it('answers from search results and returns the authoritative product records', async () => {
    llm.script(callTool('search_products', { query: 'noise cancelling headphones' }), (msgs) =>
      say(`Yes: ${msgs.at(-1)?.role === 'tool' ? 'Aurora Wireless Headphones, 129.99 USD' : '?'}`),
    );
    const res = await chat({ message: 'Do you have noise cancelling headphones?' }).expect(200);

    expect(res.body.reply).toBe('Yes: Aurora Wireless Headphones, 129.99 USD');
    expect(res.body.conversationId).toEqual(expect.any(String));
    // Stemmed full-text search: "cancelling" matches the description's "cancellation".
    expect(res.body.products[0]).toMatchObject({
      sku: 'AUD-HP-001',
      price: { amount: 12999, currency: 'USD' },
      stock: 25,
    });
    const [toolResult] = llm.toolResults() as [{ products: { sku: string; price: string }[] }];
    expect(toolResult.products[0]).toMatchObject({ sku: 'AUD-HP-001', price: '129.99 USD' });
  });

  it('sends the grounding system prompt and the tool definitions on every call', async () => {
    llm.script(say('Hello! What are you looking for?'));
    await chat({ message: 'hi' }).expect(200);
    const [req] = llm.requests;
    expect(req?.messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
    expect(req?.tools.map((t) => t.function.name).sort()).toEqual([
      'get_product',
      'list_categories',
      'search_products',
    ]);
  });

  it('reports nonexistent products as an empty result, so the model has nothing to invent', async () => {
    llm.script(
      callTool('search_products', { query: 'PlayStation 5' }),
      say("Sorry, we don't carry that."),
    );
    const res = await chat({ message: 'How much is the PlayStation 5?' }).expect(200);
    expect(llm.toolResults()).toEqual([{ products: [] }]);
    expect(res.body.products).toEqual([]);
  });

  it('applies the price filter in the search tool', async () => {
    llm.script(callTool('search_products', { query: 'wireless', maxPrice: 60 }), say('ok'));
    const res = await chat({ message: 'wireless things under $60?' }).expect(200);
    const skus = res.body.products.map((p: { sku: string }) => p.sku);
    expect(skus).toContain('AUD-EB-002'); // 59.99
    expect(skus).not.toContain('AUD-HP-001'); // 129.99
    for (const p of res.body.products) {
      expect(p.price.amount).toBeLessThanOrEqual(6000);
    }
  });

  it('includes out-of-stock products so "sold out" is not confused with "not sold"', async () => {
    llm.script(callTool('search_products', { query: 'Portable SSD 1TB' }), say('Sold out.'));
    await chat({ message: 'Is the Portable SSD 1TB in stock?' }).expect(200);
    const [result] = llm.toolResults() as [{ products: { sku: string; stock: number }[] }];
    expect(result.products[0]).toMatchObject({ sku: 'CMP-SSD-005', stock: 0 });
  });

  it('never surfaces inactive products, through search or by id', async () => {
    const inactiveId = await productIdBySku(db, 'LEG-MP3-001');
    llm.script(
      callTool('search_products', { query: 'MP3 player' }),
      callTool('get_product', { id: inactiveId }),
      say('We do not sell MP3 players.'),
    );
    const res = await chat({ message: 'Do you sell MP3 players?' }).expect(200);
    const results = llm.toolResults() as [{ products: { sku: string }[] }, unknown];
    expect(results[0].products.map((p) => p.sku)).not.toContain('LEG-MP3-001');
    expect(results[1]).toEqual({ error: 'No such product.' });
    expect(res.body.products.map((p: { sku: string }) => p.sku)).not.toContain('LEG-MP3-001');
  });

  it('gets one product in full and lists categories', async () => {
    const id = await productIdBySku(db, 'HOM-TH-004');
    llm.script(callTool('list_categories', {}), callTool('get_product', { id }), say('ok'));
    const res = await chat({ message: 'What do you sell? Tell me about the thermostat.' });
    expect(res.status).toBe(200);
    const [categories, product] = llm.toolResults() as [
      { categories: { category: string; products: number }[] },
      { product: { sku: string; price: string } },
    ];
    expect(categories.categories).toContainEqual({ category: 'Audio', products: 4 }); // MP3 inactive
    expect(product.product).toMatchObject({ sku: 'HOM-TH-004', price: '149.99 USD' });
    expect(res.body.products).toHaveLength(1);
  });
});

describe('POST /api/v1/chat — conversations', () => {
  it('continues a conversation with the stored history', async () => {
    llm.script(say('We have headphones and earbuds.'));
    const first = await chat({ message: 'audio stuff?' }).expect(200);
    llm.script(say('The earbuds are cheaper.'));
    await chat({ conversationId: first.body.conversationId, message: 'which is cheaper?' }).expect(
      200,
    );
    expect(llm.requests[0]?.messages.slice(1)).toEqual([
      { role: 'user', content: 'audio stuff?' },
      { role: 'assistant', content: 'We have headphones and earbuds.' },
      { role: 'user', content: 'which is cheaper?' },
    ]);
  });

  it('returns 404 for an unknown conversation id', async () => {
    llm.script(say('unused'));
    const res = await chat({ conversationId: crypto.randomUUID(), message: 'hi' }).expect(404);
    expect(res.body.type).toBe('/problems/not-found');
    expect(llm.requests).toHaveLength(0);
  });

  it('trims history to whole turns so no tool result is orphaned', () => {
    const history = [
      { role: 'user' as const, content: 'q1' },
      { role: 'assistant' as const, content: null, tool_calls: [] },
      { role: 'tool' as const, tool_call_id: 'x', content: '{}' },
      { role: 'assistant' as const, content: 'a1' },
      { role: 'user' as const, content: 'q2' },
      { role: 'assistant' as const, content: 'a2' },
    ];
    expect(trimHistory(history, 4)).toEqual(history.slice(4));
    expect(trimHistory(history, 6)).toEqual(history);
  });
});

describe('POST /api/v1/chat — validation and failures', () => {
  it.each([
    [{ message: '' }, '#/body/message'],
    [{ message: '   ' }, '#/body/message'],
    [{ message: 'x'.repeat(2_001) }, '#/body/message'],
    [{}, '#/body/message'],
    [{ message: 'hi', conversationId: 'not-a-uuid' }, '#/body/conversationId'],
  ])('rejects %j with 422 before calling the model', async (body, pointer) => {
    llm.script(say('unused'));
    const res = await chat(body).expect(422);
    expect(res.body.type).toBe('/problems/validation-failed');
    expect(res.body.errors[0].pointer).toBe(pointer);
    expect(llm.requests).toHaveLength(0);
  });

  it('answers 503 + Retry-After when the provider fails, leaving the conversation unchanged', async () => {
    llm.script(say('first answer'));
    const first = await chat({ message: 'hi' }).expect(200);
    llm.script(new LlmError('provider returned HTTP 502'));
    const res = await chat({ conversationId: first.body.conversationId, message: 'again' });
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.body.type).toBe('/problems/assistant-unavailable');
    expect(JSON.stringify(res.body)).not.toContain('502');
    const stored = await db.conversation.findUniqueOrThrow({
      where: { id: first.body.conversationId },
    });
    expect(stored.turn).toBe(1);
    expect(stored.messages).toHaveLength(2);
  });

  it('answers 503 when no model is configured', async () => {
    const { app: bare, db: bareDb } = createTestContext();
    const res = await request(bare).post('/api/v1/chat').send({ message: 'hi' }).expect(503);
    expect(res.body.type).toBe('/problems/assistant-unavailable');
    await bareDb.$disconnect();
  });

  it('stops after 5 tool rounds and returns a fallback reply with well-formed history', async () => {
    const loop = Array.from({ length: 6 }, () => callTool('list_categories', {}));
    llm.script(...loop);
    const res = await chat({ message: 'loop forever' }).expect(200);
    expect(llm.requests).toHaveLength(5);
    expect(res.body.reply).toMatch(/couldn't find an answer/);
    const stored = await db.conversation.findUniqueOrThrow({
      where: { id: res.body.conversationId },
    });
    expect((stored.messages as { role: string }[]).at(-1)?.role).toBe('assistant');
  });

  it('feeds invalid or unknown tool calls back to the model as errors', async () => {
    llm.script(
      callTool('search_products', '{not json'),
      callTool('search_products', { query: 'x', customerId: 'abc' }),
      callTool('drop_tables', {}),
      callTool('__proto__', {}),
      say('Sorry, could you rephrase?'),
    );
    const res = await chat({ message: 'something' }).expect(200);
    const results = llm.toolResults() as { error: string }[];
    expect(results).toHaveLength(4);
    expect(results[0]?.error).toMatch(/Invalid arguments/);
    expect(results[1]?.error).toMatch(/customerId/);
    expect(results[2]?.error).toBe('Unknown tool drop_tables.');
    expect(results[3]?.error).toBe('Unknown tool __proto__.');
    expect(res.body.reply).toBe('Sorry, could you rephrase?');
  });

  it('replaces an empty model answer with a fallback reply', async () => {
    llm.script(say('   '));
    const res = await chat({ message: 'hi' }).expect(200);
    expect(res.body.reply).toMatch(/couldn't find an answer/);
  });

  it('works for authenticated customers too', async () => {
    llm.script(say('hi Alice'));
    await request(app).post('/api/v1/chat').set(bearer(ALICE)).send({ message: 'hi' }).expect(200);
  });
});
