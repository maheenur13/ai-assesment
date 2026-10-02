import type { Express } from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { createApp, type AppDeps } from '../../server/src/app.js';
import type { Llm } from '../../server/src/assistant/llm.js';
import { loadConfig, type Config } from '../../server/src/config.js';
import { createDb, type Db } from '../../server/src/db.js';
import { seed } from '../../server/src/seed.js';
import { callTool, say, type FakeLlm } from './fake-llm.js';

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
  fetchImport?: AppDeps['fetchImport'],
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
    IMPORT_RATE_LIMIT_PER_MINUTE: '10000',
    ...overrides,
  });
  const db = createDb(url);
  const logger = pino({ level: process.env['TEST_LOG'] ?? 'silent' });
  return {
    app: createApp({
      config,
      db,
      logger,
      ...(llm && { llm }),
      ...(fetchImport && { fetchImport }),
    }),
    db,
    config,
  };
}

/** Empties every table and reloads fixtures: each test starts from the same known state. */
export async function resetDb(db: Db): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE import_runs, order_proposals, conversations, idempotency_records, order_items, orders, customers, products RESTART IDENTITY CASCADE',
  );
  await seed(db);
}

export async function productIdBySku(db: Db, sku: string): Promise<string> {
  const p = await db.product.findUniqueOrThrow({ where: { sku }, select: { id: true } });
  return p.id;
}

/** One chat turn in which the (fake) model proposes `items`; returns the conversation and proposal. */
export async function proposeViaChat(
  app: Express,
  llm: FakeLlm,
  token: string,
  items: { productId: string; quantity: number }[],
): Promise<{ conversationId: string; proposalId: string }> {
  llm.script(callTool('propose_order', { items }), say('Shall I place it?'));
  const res = await request(app)
    .post('/api/v1/chat')
    .set(bearer(token))
    .send({ message: 'I want to order' })
    .expect(200);
  return { conversationId: res.body.conversationId, proposalId: res.body.proposal.id };
}
