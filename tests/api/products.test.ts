import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bearer,
  createTestContext,
  OPERATOR_TOKEN,
  productIdBySku,
  resetDb,
} from '../helpers/app.js';

const { app, db } = createTestContext();
const operator = bearer(OPERATOR_TOKEN);

const newProduct = {
  sku: 'TST-NEW-001',
  name: 'Test Lamp',
  description: 'A lamp for tests',
  category: 'Home',
  price: { amount: 2500, currency: 'USD' },
  stock: 10,
};

beforeEach(() => resetDb(db));
afterAll(() => db.$disconnect());

describe('GET /api/v1/products', () => {
  it('lists only active products, newest first, with money as minor units', async () => {
    const res = await request(app).get('/api/v1/products?limit=100').expect(200);
    expect(res.body.data.length).toBe(23); // 24 seeded, 1 inactive
    expect(res.body.data.every((p: { isActive: boolean }) => p.isActive)).toBe(true);
    expect(res.body.data[0].price).toEqual({ amount: expect.any(Number), currency: 'USD' });
  });

  it('paginates with an opaque cursor without duplicates or gaps', async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const res = await request(app)
        .get('/api/v1/products')
        .query({ limit: 5, ...(cursor && { cursor }) })
        .expect(200);
      for (const p of res.body.data) seen.add(p.id);
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen.size).toBe(23);
  });

  it('clamps limit to 100', async () => {
    const res = await request(app).get('/api/v1/products?limit=5000').expect(200);
    expect(res.body.data.length).toBeLessThanOrEqual(100);
  });

  it('filters by text, category (case-insensitive), price range and stock', async () => {
    const q = await request(app).get('/api/v1/products?q=keyboard').expect(200);
    expect(q.body.data.map((p: { sku: string }) => p.sku)).toEqual(['CMP-KB-001']);

    const cat = await request(app).get('/api/v1/products?category=smart%20home').expect(200);
    expect(cat.body.data).toHaveLength(4);

    const price = await request(app)
      .get('/api/v1/products?minPrice=10000&maxPrice=20000')
      .expect(200);
    for (const p of price.body.data) {
      expect(p.price.amount).toBeGreaterThanOrEqual(10000);
      expect(p.price.amount).toBeLessThanOrEqual(20000);
    }

    const inStock = await request(app).get('/api/v1/products?inStock=true&limit=100').expect(200);
    expect(inStock.body.data.find((p: { sku: string }) => p.sku === 'CMP-SSD-005')).toBeUndefined();
  });

  it('rejects unknown query parameters and bad values with 422 + pointers', async () => {
    const res = await request(app).get('/api/v1/products?limit=0&colour=red').expect(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const pointers = res.body.errors.map((e: { pointer: string }) => e.pointer);
    expect(pointers).toContain('#/query/limit');
  });

  it('rejects a tampered cursor', async () => {
    const res = await request(app).get('/api/v1/products?cursor=not-a-cursor').expect(422);
    expect(res.body.errors[0].pointer).toBe('#/query/cursor');
  });
});

describe('GET /api/v1/products/:id', () => {
  it('returns an active product', async () => {
    const id = await productIdBySku(db, 'AUD-HP-001');
    const res = await request(app).get(`/api/v1/products/${id}`).expect(200);
    expect(res.body).toMatchObject({
      sku: 'AUD-HP-001',
      price: { amount: 12999, currency: 'USD' },
    });
  });

  it('hides inactive products from the public but not from the operator', async () => {
    const id = await productIdBySku(db, 'LEG-MP3-001');
    await request(app).get(`/api/v1/products/${id}`).expect(404);
    await request(app).get(`/api/v1/products/${id}`).set(operator).expect(200);
  });

  it('returns 404 for unknown and malformed ids', async () => {
    await request(app).get('/api/v1/products/7d1f0c1e-0000-4000-8000-000000000000').expect(404);
    await request(app).get('/api/v1/products/not-a-uuid').expect(404);
  });
});

describe('POST /api/v1/products (operator)', () => {
  it('creates a product with 201 + Location', async () => {
    const res = await request(app)
      .post('/api/v1/products')
      .set(operator)
      .send(newProduct)
      .expect(201);
    expect(res.headers['location']).toBe(`/api/v1/products/${res.body.id}`);
    expect(res.body).toMatchObject({ sku: 'TST-NEW-001', stock: 10, isActive: true });
  });

  it('rejects a duplicate SKU with 409', async () => {
    const res = await request(app)
      .post('/api/v1/products')
      .set(operator)
      .send({ ...newProduct, sku: 'AUD-HP-001' })
      .expect(409);
    expect(res.body.type).toBe('/problems/duplicate-sku');
  });

  it.each([
    ['zero price', { price: { amount: 0, currency: 'USD' } }, '#/body/price/amount'],
    ['fractional price', { price: { amount: 19.99, currency: 'USD' } }, '#/body/price/amount'],
    ['negative stock', { stock: -1 }, '#/body/stock'],
    ['empty name', { name: '   ' }, '#/body/name'],
    ['bad sku', { sku: 'has spaces' }, '#/body/sku'],
  ])('rejects %s with 422', async (_label, patch, pointer) => {
    const res = await request(app)
      .post('/api/v1/products')
      .set(operator)
      .send({ ...newProduct, ...patch })
      .expect(422);
    expect(res.body.errors.map((e: { pointer: string }) => e.pointer)).toContain(pointer);
  });

  it('rejects a currency other than the store currency', async () => {
    const res = await request(app)
      .post('/api/v1/products')
      .set(operator)
      .send({ ...newProduct, price: { amount: 100, currency: 'EUR' } })
      .expect(422);
    expect(res.body.errors[0].pointer).toBe('#/body/price/currency');
  });
});

describe('PATCH /api/v1/products/:id (operator)', () => {
  it('updates only the provided fields', async () => {
    const id = await productIdBySku(db, 'AUD-SP-003');
    const res = await request(app)
      .patch(`/api/v1/products/${id}`)
      .set(operator)
      .send({ stock: 99 })
      .expect(200);
    expect(res.body).toMatchObject({
      stock: 99,
      name: 'Boom Mini Bluetooth Speaker',
      isActive: true,
    });
    expect(res.body.description).toContain('Pocket-sized');
  });

  it('rejects an empty patch and an attempt to change the SKU', async () => {
    const id = await productIdBySku(db, 'AUD-SP-003');
    await request(app).patch(`/api/v1/products/${id}`).set(operator).send({}).expect(422);
    await request(app).patch(`/api/v1/products/${id}`).set(operator).send({ sku: 'X' }).expect(422);
  });

  it('returns 404 for an unknown product', async () => {
    await request(app)
      .patch('/api/v1/products/7d1f0c1e-0000-4000-8000-000000000000')
      .set(operator)
      .send({ stock: 1 })
      .expect(404);
  });
});
