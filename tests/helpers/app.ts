import type { Express } from 'express';
import { pino } from 'pino';
import { createApp } from '../../server/src/app.js';
import type { Llm } from '../../server/src/assistant/llm.js';
import { loadConfig, type Config } from '../../server/src/config.js';
import { createDb, type Db } from '../../server/src/db.js';
import { seed } from '../../server/src/seed.js';

export const OPERATOR_TOKEN = 'test-operator-token-0123456789-abcdefghij';
export const ALICE = 'shop_demo_alice_0000000000000000000000000000000000000000';
export const BOB = 'shop_demo_bob_00000000000000000000000000000000000000000000';
export const ALICE_ORDER_ID = '0b6a5d2e-6a39-4c55-9a35-6d8f6c3a1001';
export const BOB_ORDER_ID = '0b6a5d2e-6a39-4c55-9a35-6d8f6c3a2001';

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export interface TestContext {
  app: Express;
  db: Db;
  config: Config;
}

export function createTestContext(
  overrides: Partial<Record<string, string>> = {},
  llm?: Llm,
): TestContext {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) throw new Error('TEST_DATABASE_URL must be set');
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: url,
    OPERATOR_TOKEN,
    RATE_LIMIT_PER_MINUTE: '10000',
    ORDER_RATE_LIMIT_PER_MINUTE: '10000',
    CHAT_RATE_LIMIT_PER_MINUTE: '10000',
    ...overrides,
  });
  const db = createDb(url);
  const logger = pino({ level: 'silent' });
  return { app: createApp({ config, db, logger, ...(llm && { llm }) }), db, config };
}

/** Empties every table and reloads fixtures: each test starts from the same known state. */
export async function resetDb(db: Db): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE conversations, idempotency_records, order_items, orders, customers, products RESTART IDENTITY CASCADE',
  );
  await seed(db);
}

export async function productIdBySku(db: Db, sku: string): Promise<string> {
  const p = await db.product.findUniqueOrThrow({ where: { sku }, select: { id: true } });
  return p.id;
}
