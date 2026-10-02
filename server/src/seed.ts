import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createDb, type Db } from './db.js';
import { hashToken } from './http/auth.js';

const productFixture = z.object({
  sku: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  priceCents: z.number().int().positive(),
  stock: z.number().int().min(0),
  isActive: z.boolean().default(true),
});
const customerFixture = z.object({ email: z.email(), name: z.string(), token: z.string().min(32) });
const orderFixture = z.object({
  id: z.uuid(),
  customerEmail: z.email(),
  createdAt: z.iso.datetime(),
  items: z.array(z.object({ sku: z.string(), quantity: z.number().int().positive() })).min(1),
});

async function load<T extends z.ZodType>(
  dir: string,
  file: string,
  schema: T,
): Promise<z.infer<T>[]> {
  const raw: unknown = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
  return z.array(schema).parse(raw);
}

/**
 * Inserts fixture data that is missing and never overwrites existing rows, so it is safe to run
 * on every container start without clobbering operator edits or stock changes.
 */
export async function seed(db: Db, dir = path.resolve('fixtures/seed')): Promise<void> {
  const products = await load(dir, 'products.json', productFixture);
  const customers = await load(dir, 'customers.json', customerFixture);
  const orders = await load(dir, 'orders.json', orderFixture);

  await db.$transaction(async (tx) => {
    await tx.product.createMany({ data: products, skipDuplicates: true });
    await tx.customer.createMany({
      data: customers.map((c) => ({
        email: c.email,
        name: c.name,
        tokenHash: hashToken(c.token),
        tokenPrefix: c.token.slice(0, 12),
      })),
      skipDuplicates: true,
    });

    const productBySku = new Map(
      (
        await tx.product.findMany({ select: { id: true, sku: true, name: true, priceCents: true } })
      ).map((p) => [p.sku, p]),
    );
    const customerByEmail = new Map(
      (await tx.customer.findMany({ select: { id: true, email: true } })).map((c) => [
        c.email,
        c.id,
      ]),
    );

    // Historical orders: snapshots only, stock is not decremented.
    for (const order of orders) {
      if (await tx.order.findUnique({ where: { id: order.id }, select: { id: true } })) continue;
      const customerId = customerByEmail.get(order.customerEmail);
      if (!customerId)
        throw new Error(`Seed order ${order.id}: unknown customer ${order.customerEmail}`);
      const items = order.items.map((i) => {
        const p = productBySku.get(i.sku);
        if (!p) throw new Error(`Seed order ${order.id}: unknown SKU ${i.sku}`);
        return {
          productId: p.id,
          productName: p.name,
          unitPriceCents: p.priceCents,
          quantity: i.quantity,
        };
      });
      await tx.order.create({
        data: {
          id: order.id,
          customerId,
          createdAt: new Date(order.createdAt),
          totalCents: items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0),
          items: { create: items },
        },
      });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.loadEnvFile();
  } catch {
    // Environment provided externally.
  }
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');
  const db = createDb(url);
  await seed(db);
  await db.$disconnect();
  // eslint-disable-next-line no-console
  console.log('Seed complete');
}
