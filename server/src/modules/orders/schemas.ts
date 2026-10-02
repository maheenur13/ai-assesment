import { z } from 'zod';
import { moneySchema } from '../shared.js';

export const MAX_QUANTITY_PER_LINE = 100;
export const MAX_LINES_PER_ORDER = 50;

export const createOrderBody = z
  .object({
    items: z
      .array(
        z
          .object({
            productId: z.uuid(),
            quantity: z.number().int().min(1).max(MAX_QUANTITY_PER_LINE),
          })
          .strict(),
      )
      .min(1, 'An order needs at least one item')
      .max(MAX_LINES_PER_ORDER)
      .refine(
        (items) => new Set(items.map((i) => i.productId)).size === items.length,
        'Each product may appear only once; combine quantities instead',
      ),
  })
  .strict()
  .meta({ id: 'CreateOrder' });

export const orderSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(['placed']),
    items: z.array(
      z.object({
        productId: z.uuid(),
        productName: z.string(),
        unitPrice: moneySchema,
        quantity: z.number().int(),
        lineTotal: moneySchema,
      }),
    ),
    total: moneySchema,
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Order' });

/** Idempotency-Key header (IETF draft): an opaque client string, typically a UUID. */
export const idempotencyKeySchema = z
  .string()
  .regex(/^[\x21-\x7e]{1,255}$/, 'Idempotency-Key must be 1-255 printable ASCII characters');

export type CreateOrderInput = z.infer<typeof createOrderBody>;
export type OrderDto = z.infer<typeof orderSchema>;
