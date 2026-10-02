import type { Db } from '../../db.js';
import type { Product, Prisma } from '../../generated/prisma/client.js';
import { afterCursor, keysetOrder, page } from '../../http/pagination.js';
import { problems } from '../../http/problem.js';
import { assertStoreCurrency, toMoney } from '../shared.js';
import type {
  CreateProductInput,
  ListProductsQuery,
  ProductDto,
  UpdateProductInput,
} from './schemas.js';

export function toProductDto(p: Product, currency: string): ProductDto {
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    description: p.description,
    category: p.category,
    price: toMoney(p.priceCents, currency),
    stock: p.stock,
    isActive: p.isActive,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** Catalog queries and operator writes. Shared by the REST API and (later) the assistant tools. */
export class ProductService {
  constructor(
    private readonly db: Db,
    private readonly currency: string,
  ) {}

  /** Customers and anonymous callers only ever see active products. */
  async list(query: ListProductsQuery, includeInactive = false) {
    const where: Prisma.ProductWhereInput = {
      ...(!includeInactive && { isActive: true }),
      ...(query.category !== undefined && {
        category: { equals: query.category, mode: 'insensitive' },
      }),
      ...(query.inStock === true && { stock: { gt: 0 } }),
      ...((query.minPrice !== undefined || query.maxPrice !== undefined) && {
        priceCents: {
          ...(query.minPrice !== undefined && { gte: query.minPrice }),
          ...(query.maxPrice !== undefined && { lte: query.maxPrice }),
        },
      }),
      ...(query.q !== undefined && {
        OR: [
          { name: { contains: query.q, mode: 'insensitive' } },
          { description: { contains: query.q, mode: 'insensitive' } },
          { sku: { equals: query.q, mode: 'insensitive' } },
        ],
      }),
    };
    const rows = await this.db.product.findMany({
      where: { AND: [where, afterCursor(query.cursor)] },
      orderBy: keysetOrder,
      take: query.limit + 1,
    });
    return page(rows, query.limit, (p) => toProductDto(p, this.currency));
  }

  async get(id: string, includeInactive = false): Promise<ProductDto> {
    const product = await this.db.product.findUnique({ where: { id } });
    if (!product || (!product.isActive && !includeInactive)) throw problems.notFound('Product');
    return toProductDto(product, this.currency);
  }

  async create(input: CreateProductInput): Promise<ProductDto> {
    assertStoreCurrency(input.price, this.currency, '#/body/price/currency');
    const existing = await this.db.product.findUnique({ where: { sku: input.sku } });
    if (existing) {
      throw problems.conflict('duplicate-sku', 'SKU already exists', `SKU ${input.sku} is taken`);
    }
    const product = await this.db.product.create({
      data: {
        sku: input.sku,
        name: input.name,
        description: input.description,
        category: input.category,
        priceCents: input.price.amount,
        stock: input.stock,
        isActive: input.isActive,
      },
    });
    return toProductDto(product, this.currency);
  }

  async update(id: string, input: UpdateProductInput): Promise<ProductDto> {
    if (input.price) assertStoreCurrency(input.price, this.currency, '#/body/price/currency');
    const product = await this.db.product.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.category !== undefined && { category: input.category }),
        ...(input.price !== undefined && { priceCents: input.price.amount }),
        ...(input.stock !== undefined && { stock: input.stock }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
      },
    });
    return toProductDto(product, this.currency);
  }
}
