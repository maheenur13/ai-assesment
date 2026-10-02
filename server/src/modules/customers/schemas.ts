import { z } from 'zod';

export const createCustomerBody = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((e) => e.toLowerCase()),
    name: z.string().trim().min(1).max(200),
  })
  .strict()
  .meta({ id: 'CreateCustomer' });

export const customerSchema = z
  .object({
    id: z.uuid(),
    email: z.email(),
    name: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Customer' });

export const createdCustomerSchema = z
  .object({
    customer: customerSchema,
    token: z.string().describe('Bearer token. Shown only once; store it securely.'),
  })
  .meta({ id: 'CreatedCustomer' });

export type CreateCustomerInput = z.infer<typeof createCustomerBody>;
export type CustomerDto = z.infer<typeof customerSchema>;
