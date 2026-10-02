import type { Db } from '../../db.js';
import type { Customer } from '../../generated/prisma/client.js';
import { generateCustomerToken } from '../../http/auth.js';
import { problems } from '../../http/problem.js';
import type { CreateCustomerInput, CustomerDto } from './schemas.js';

/** Explicit DTO: the token hash never leaves the server (OWASP API3). */
export const toCustomerDto = (c: Customer): CustomerDto => ({
  id: c.id,
  email: c.email,
  name: c.name,
  createdAt: c.createdAt.toISOString(),
});

export class CustomerService {
  constructor(private readonly db: Db) {}

  async create(input: CreateCustomerInput): Promise<{ customer: CustomerDto; token: string }> {
    const existing = await this.db.customer.findUnique({ where: { email: input.email } });
    if (existing) throw problems.conflict('duplicate-email', 'Email already registered');
    const { token, hash, prefix } = generateCustomerToken();
    const customer = await this.db.customer.create({
      data: { email: input.email, name: input.name, tokenHash: hash, tokenPrefix: prefix },
    });
    return { customer: toCustomerDto(customer), token };
  }

  async get(id: string): Promise<CustomerDto> {
    const customer = await this.db.customer.findUnique({ where: { id } });
    if (!customer) throw problems.notFound('Customer');
    return toCustomerDto(customer);
  }
}
