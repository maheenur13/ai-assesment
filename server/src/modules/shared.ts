import { z } from 'zod';
import { problems } from '../http/problem.js';

/** Money on the wire: integer minor units + ISO 4217 code. Never floats. */
export const moneySchema = z
  .object({
    amount: z.number().int().positive().max(100_000_000).describe('Minor units, e.g. cents'),
    currency: z.string().regex(/^[A-Z]{3}$/, 'Must be an ISO 4217 code'),
  })
  .strict()
  .meta({ id: 'Money' });

export type Money = z.infer<typeof moneySchema>;

export const toMoney = (amount: number, currency: string): Money => ({ amount, currency });

export function assertStoreCurrency(money: Money, storeCurrency: string, pointer: string): void {
  if (money.currency !== storeCurrency) {
    throw problems.validation([{ pointer, detail: `This store only accepts ${storeCurrency}` }]);
  }
}

const uuid = z.uuid();

/** Malformed ids can never match a row, so they are reported as 404, not 422. */
export function idParam(value: unknown, what: string): string {
  const result = uuid.safeParse(value);
  if (!result.success) throw problems.notFound(what);
  return result.data;
}
