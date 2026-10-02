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
    const existing = await this.db.customer.findFirst({
      where: { email: input.email, isGuest: false },
    });
    if (existing) throw problems.conflict('duplicate-email', 'Email already registered');
    const { token, hash, prefix } = generateCustomerToken();
    const customer = await this.db.customer.create({
      data: { email: input.email, name: input.name, tokenHash: hash, tokenPrefix: prefix },
    });
    return { customer: toCustomerDto(customer), token };
  }

  /**
   * Creates or updates the guest behind an anonymous chat checkout. Guests get no token: they act
   * only through the conversation they ordered in. `guestId` is that conversation's existing guest.
   */
  async saveGuest(input: CreateCustomerInput, guestId: string | null): Promise<string> {
    if (guestId) {
      const { count } = await this.db.customer.updateMany({
        where: { id: guestId, isGuest: true },
        data: { email: input.email, name: input.name },
      });
      if (count === 1) return guestId;
    }
    const guest = await this.db.customer.create({
      data: { email: input.email, name: input.name, isGuest: true },
      select: { id: true },
    });
    return guest.id;
  }

  async get(id: string): Promise<CustomerDto> {
    const customer = await this.db.customer.findUnique({ where: { id } });
    if (!customer) throw problems.notFound('Customer');
    return toCustomerDto(customer);
  }
}
