import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ALICE, bearer, createTestContext, OPERATOR_TOKEN, resetDb } from '../helpers/app.js';

const { app, db } = createTestContext();
const operator = bearer(OPERATOR_TOKEN);

beforeEach(() => resetDb(db));
afterAll(() => db.$disconnect());

describe('customers', () => {
  it('operator registers a customer; the one-time token authenticates as them', async () => {
    const res = await request(app)
      .post('/api/v1/customers')
      .set(operator)
      .send({ email: 'Dana@Example.com', name: 'Dana' })
      .expect(201);
    expect(res.body.token).toMatch(/^shop_[A-Za-z0-9_-]{43}$/);
    expect(res.body.customer.email).toBe('dana@example.com');
    expect(res.headers['location']).toBe(`/api/v1/customers/${res.body.customer.id}`);
    expect(JSON.stringify(res.body)).not.toContain('tokenHash');

    const me = await request(app).get('/api/v1/me').set(bearer(res.body.token)).expect(200);
    expect(me.body).toMatchObject({ id: res.body.customer.id, name: 'Dana' });

    // Only the hash is stored.
    const row = await db.customer.findUniqueOrThrow({ where: { id: res.body.customer.id } });
    expect(row.tokenHash).not.toContain(res.body.token);
  });

  it('rejects duplicate email (case-insensitive) with 409', async () => {
    await request(app)
      .post('/api/v1/customers')
      .set(operator)
      .send({ email: 'ALICE@example.com', name: 'Imposter' })
      .expect(409);
  });

  it('validates email and name', async () => {
    const res = await request(app)
      .post('/api/v1/customers')
      .set(operator)
      .send({ email: 'nope', name: '' })
      .expect(422);
    const pointers = res.body.errors.map((e: { pointer: string }) => e.pointer);
    expect(pointers).toEqual(expect.arrayContaining(['#/body/email', '#/body/name']));
  });

  it('GET /me returns the authenticated customer only', async () => {
    const me = await request(app).get('/api/v1/me').set(bearer(ALICE)).expect(200);
    expect(me.body.email).toBe('alice@example.com');
  });
});
