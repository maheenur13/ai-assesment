import { z } from 'zod';
import { moneySchema } from '../shared.js';
import { paginationQuery } from '../../http/pagination.js';

const text = (max: number) => z.string().trim().min(1).max(max);

// No defaults here: zod's .partial() keeps defaults, which would make PATCH overwrite fields.
const productFields = z.object({
  name: text(200),
  description: z.string().trim().max(5_000),
  category: text(100),
  price: moneySchema,
  stock: z.number().int().min(0).max(1_000_000),
  isActive: z.boolean(),
});

export const createProductBody = productFields
  .extend({
    sku: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'Letters, digits, ".", "_" or "-" (max 64)'),
    description: productFields.shape.description.default(''),
    isActive: productFields.shape.isActive.default(true),
  })
  .strict()
  .meta({ id: 'CreateProduct' });

/** Merge-patch semantics: absent = unchanged. `sku` is the immutable business key. */
export const updateProductBody = productFields
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'Provide at least one field to update')
  .meta({ id: 'UpdateProduct' });

const booleanString = z.enum(['true', 'false']).transform((v) => v === 'true');

export const listProductsQuery = paginationQuery
  .extend({
    q: z.string().trim().min(1).max(200).optional(),
    category: z.string().trim().min(1).max(100).optional(),
    minPrice: z.coerce.number().int().min(0).optional(),
    maxPrice: z.coerce.number().int().min(0).optional(),
    inStock: booleanString.optional(),
  })
  .strict();

export const productSchema = z
  .object({
    id: z.uuid(),
    sku: z.string(),
    name: z.string(),
    description: z.string(),
    category: z.string(),
    price: moneySchema,
    stock: z.number().int(),
    isActive: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Product' });

export type CreateProductInput = z.infer<typeof createProductBody>;
export type UpdateProductInput = z.infer<typeof updateProductBody>;
export type ListProductsQuery = z.infer<typeof listProductsQuery>;
export type ProductDto = z.infer<typeof productSchema>;
