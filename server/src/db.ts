import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export type Db = PrismaClient;

export function createDb(connectionString: string): Db {
  // statement_timeout bounds any runaway query (OWASP API4: unrestricted resource consumption).
  const adapter = new PrismaPg({ connectionString, statement_timeout: 5_000 });
  return new PrismaClient({ adapter });
}
