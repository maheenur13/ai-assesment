import { z } from 'zod';
import { problems } from './problem.js';

/** Keyset pagination over (createdAt DESC, id DESC); the cursor is opaque to clients. */
export const paginationQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(20)
    .transform((n) => Math.min(n, 100)),
  cursor: z.string().max(200).optional(),
});

interface CursorKey {
  createdAt: Date;
  id: string;
}

const cursorSchema = z.object({ c: z.iso.datetime(), i: z.uuid() });

export function encodeCursor(row: CursorKey): string {
  return Buffer.from(JSON.stringify({ c: row.createdAt.toISOString(), i: row.id })).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): CursorKey {
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
    return { createdAt: new Date(parsed.c), id: parsed.i };
  } catch {
    throw problems.validation([{ pointer: '#/query/cursor', detail: 'Invalid cursor' }]);
  }
}

/** Prisma `where` fragment selecting rows strictly after the cursor. */
export function afterCursor(cursor: string | undefined) {
  if (cursor === undefined) return {};
  const key = decodeCursor(cursor);
  return {
    OR: [{ createdAt: { lt: key.createdAt } }, { createdAt: key.createdAt, id: { lt: key.id } }],
  };
}

export const keysetOrder = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

/** Fetch `limit + 1` rows, then call this to build the `{ data, nextCursor }` envelope. */
export function page<T extends CursorKey, R>(rows: T[], limit: number, map: (row: T) => R) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    data: items.map(map),
    ...(hasMore && last && { nextCursor: encodeCursor(last) }),
  };
}
