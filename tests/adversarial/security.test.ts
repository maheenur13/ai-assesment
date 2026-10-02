import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ALICE,
  BOB,
  BOB_ORDER_ID,
  bearer,
  createTestContext,
  OPERATOR_TOKEN,
  productIdBySku,
  resetDb,
} from '../helpers/app.js';

const { app, db } = createTestContext();

beforeEach(() => resetDb(db));
afterAll(() => db.$disconnect());

describe('broken object level authorization (OWASP API1)', () => {
  it("a customer cannot read another customer's order; response is indistinguishable from 404", async () => {
    const foreign = await request(app)
      .get(`/api/v1/orders/${BOB_ORDER_ID}`)
      .set(bearer(ALICE))
      .expect(404);
    const missing = await request(app)
      .get(`/api/v1/orders/${randomUUID()}`)
      .set(bearer(ALICE))
      .expect(404);
    expect(foreign.body.title).toBe(missing.body.title);
    await request(app).get(`/api/v1/orders/${BOB_ORDER_ID}`).set(bearer(BOB)).expect(200);
  });

  it("order listing never includes other customers' orders", async () => {
    const res = await request(app).get('/api/v1/orders?limit=100').set(bearer(ALICE)).expect(200);
    expect(res.body.data.map((o: { id: string }) => o.id)).not.toContain(BOB_ORDER_ID);
  });

  it('a customer cannot place an order on behalf of someone else (mass assignment)', async () => {
    const id = await productIdBySku(db, 'AUD-HP-001');
    const bob = await db.customer.findFirstOrThrow({
      where: { email: 'bob@example.com', isGuest: false },
    });
    await request(app)
      .post('/api/v1/orders')
      .set(bearer(ALICE))
      .set('Idempotency-Key', randomUUID())
      .send({ customerId: bob.id, items: [{ productId: id, quantity: 1 }] })
      .expect(422);
  });

  it('a client cannot set its own price or total', async () => {
    const id = await productIdBySku(db, 'AUD-HP-001');
    await request(app)
      .post('/api/v1/orders')
      .set(bearer(ALICE))
      .set('Idempotency-Key', randomUUID())
      .send({ items: [{ productId: id, quantity: 1, unitPriceCents: 1 }], totalCents: 1 })
      .expect(422);
  });
});

describe('authentication and function level authorization (OWASP API2/API5)', () => {
  it('requires a token for customer endpoints (401 + WWW-Authenticate)', async () => {
    const res = await request(app).get('/api/v1/orders').expect(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it.each([
    ['an unknown token', 'Bearer shop_not_a_real_token_000000000000000000000000000'],
    ['a non-bearer scheme', 'Basic YWxpY2U6cGFzc3dvcmQ='],
    ['an empty bearer', 'Bearer '],
    ['a token with control characters', 'Bearer abc\tdef'],
  ])('rejects %s with 401, even on public routes', async (_label, header) => {
    await request(app).get('/api/v1/products').set('Authorization', header).expect(401);
  });

  it('customer tokens cannot use operator endpoints (403)', async () => {
    await request(app)
      .post('/api/v1/products')
      .set(bearer(ALICE))
      .send({
        sku: 'X-1',
        name: 'x',
        category: 'x',
        price: { amount: 1, currency: 'USD' },
        stock: 1,
      })
      .expect(403);
    await request(app)
      .post('/api/v1/customers')
      .set(bearer(ALICE))
      .send({ email: 'evil@example.com', name: 'Evil' })
      .expect(403);
  });

  it('the operator is not a customer and cannot place orders', async () => {
    await request(app).get('/api/v1/orders').set(bearer(OPERATOR_TOKEN)).expect(403);
  });

  it('client-supplied identity fields on product create are rejected', async () => {
    await request(app)
      .post('/api/v1/products')
      .set(bearer(OPERATOR_TOKEN))
      .send({
        id: randomUUID(),
        createdAt: '2000-01-01T00:00:00Z',
        sku: 'X-1',
        name: 'x',
        category: 'x',
        price: { amount: 1, currency: 'USD' },
        stock: 1,
      })
      .expect(422);
  });
});

describe('hostile and malformed input', () => {
  it('malformed JSON → 400 problem document', async () => {
    const res = await request(app)
      .post('/api/v1/customers')
      .set(bearer(OPERATOR_TOKEN))
      .set('Content-Type', 'application/json')
      .send('{"email": "a@b.c", ')
      .expect(400);
    expect(res.body.type).toBe('/problems/malformed-json');
  });

  it('non-JSON bodies → 415', async () => {
    await request(app)
      .post('/api/v1/customers')
      .set(bearer(OPERATOR_TOKEN))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('email=a@b.c&name=x')
      .expect(415);
  });

  it('oversized bodies → 413', async () => {
    await request(app)
      .post('/api/v1/customers')
      .set(bearer(OPERATOR_TOKEN))
      .send({ email: 'a@b.c', name: 'x'.repeat(200_000) })
      .expect(413);
  });

  it('SQL-injection-shaped search terms are treated as plain text', async () => {
    const res = await request(app).get("/api/v1/products?q=' OR 1=1 --").expect(200);
    expect(res.body.data).toEqual([]);
    expect(await db.product.count()).toBe(24);
  });

  it('prototype-pollution payloads are rejected by strict schemas', async () => {
    await request(app)
      .post('/api/v1/customers')
      .set(bearer(OPERATOR_TOKEN))
      .set('Content-Type', 'application/json')
      .send('{"email":"p@example.com","name":"P","__proto__":{"isAdmin":true}}')
      .expect(422);
    expect(({} as Record<string, unknown>)['isAdmin']).toBeUndefined();
  });

  it('a forged X-Request-Id is replaced; a well-formed one is echoed', async () => {
    const forged = await request(app).get('/healthz').set('X-Request-Id', 'x'.repeat(500));
    expect(forged.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const ok = await request(app).get('/healthz').set('X-Request-Id', 'trace-123');
    expect(ok.headers['x-request-id']).toBe('trace-123');
  });
});

describe('security misconfiguration (OWASP API8)', () => {
  it('sends hardening headers and hides the framework', async () => {
    const res = await request(app).get('/api/v1/products');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    // Off on purpose: the app is served over plain HTTP (see decisions D27).
    expect(res.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
  });

  it('unknown routes return a problem document, never a stack trace', async () => {
    const res = await request(app).get('/api/v1/nope').expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.ts:\d+/);
  });

  it('health endpoints report liveness and readiness', async () => {
    await request(app).get('/healthz').expect(200, { status: 'ok' });
    await request(app).get('/readyz').expect(200, { status: 'ready' });
  });
});

describe('unrestricted resource consumption (OWASP API4)', () => {
  it('rate limits per identity with standard headers and a 429 problem', async () => {
    const limited = createTestContext({ RATE_LIMIT_PER_MINUTE: '3' });
    try {
      for (let i = 0; i < 3; i++) await request(limited.app).get('/api/v1/products').expect(200);
      const res = await request(limited.app).get('/api/v1/products').expect(429);
      expect(res.body.type).toBe('/problems/rate-limited');
      expect(res.headers['ratelimit-policy']).toBeDefined();
    } finally {
      await limited.db.$disconnect();
    }
  });
});
