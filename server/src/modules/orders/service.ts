import { createHash } from 'node:crypto';
import type { Db } from '../../db.js';
import { Prisma, type Order, type OrderItem } from '../../generated/prisma/client.js';
import { afterCursor, keysetOrder, page } from '../../http/pagination.js';
import { problems } from '../../http/problem.js';
import { toMoney } from '../shared.js';
import type { CreateOrderInput, OrderDto } from './schemas.js';

/** Replays older than this are treated as new requests (the draft leaves retention to servers). */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

type OrderWithItems = Order & { items: OrderItem[] };

export interface OrderResult {
  status: number;
  body: OrderDto;
  /** True when the response was replayed from an earlier request with the same key. */
  replayed: boolean;
}

export class OrderService {
  constructor(
    private readonly db: Db,
    private readonly currency: string,
  ) {}

  toDto(order: OrderWithItems): OrderDto {
    const c = this.currency;
    return {
      id: order.id,
      status: order.status,
      items: order.items.map((i) => ({
        productId: i.productId,
        productName: i.productName,
        unitPrice: toMoney(i.unitPriceCents, c),
        quantity: i.quantity,
        lineTotal: toMoney(i.unitPriceCents * i.quantity, c),
      })),
      total: toMoney(order.totalCents, c),
      createdAt: order.createdAt.toISOString(),
    };
  }

  /**
   * Places an order atomically: validates products, decrements stock with a conditional update
   * (no oversell under concurrency), snapshots prices, and records the idempotent response in the
   * same transaction. A concurrent duplicate blocks on the unique (customer, key) index and rolls
   * back, after which it replays the committed response.
   */
  async create(customerId: string, input: CreateOrderInput, key: string): Promise<OrderResult> {
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');

    const replay = await this.findReplay(customerId, key, requestHash);
    if (replay) return replay;

    try {
      const order = await this.db.$transaction(async (tx) => {
        const ids = input.items.map((i) => i.productId);
        const products = await tx.product.findMany({ where: { id: { in: ids } } });
        const byId = new Map(products.map((p) => [p.id, p]));

        const invalid = input.items.flatMap((item, index) => {
          const p = byId.get(item.productId);
          return p?.isActive
            ? []
            : [
                {
                  pointer: `#/body/items/${index}/productId`,
                  detail: 'Unknown or unavailable product',
                },
              ];
        });
        if (invalid.length > 0) throw problems.validation(invalid);

        // Lock rows in a stable order to avoid deadlocks between concurrent orders.
        const lines = [...input.items].sort((a, b) => a.productId.localeCompare(b.productId));
        for (const line of lines) {
          const { count } = await tx.product.updateMany({
            where: { id: line.productId, stock: { gte: line.quantity } },
            data: { stock: { decrement: line.quantity } },
          });
          if (count === 0) {
            throw problems.conflict(
              'insufficient-stock',
              'Insufficient stock',
              `Not enough stock for product ${line.productId}`,
              { productId: line.productId },
            );
          }
        }

        const items = input.items.map((line) => {
          const p = byId.get(line.productId)!;
          return {
            productId: p.id,
            productName: p.name,
            unitPriceCents: p.priceCents,
            quantity: line.quantity,
          };
        });
        const totalCents = items.reduce((sum, i) => sum + i.unitPriceCents * i.quantity, 0);
        const created = await tx.order.create({
          data: { customerId, totalCents, items: { create: items } },
          include: { items: true },
        });
        await tx.idempotencyRecord.create({
          data: {
            customerId,
            key,
            requestHash,
            responseStatus: 201,
            responseBody: this.toDto(created),
          },
        });
        return created;
      });
      return { status: 201, body: this.toDto(order), replayed: false };
    } catch (err) {
      // Lost the race to a concurrent request with the same key: replay its committed result.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const raced = await this.findReplay(customerId, key, requestHash);
        if (raced) return raced;
      }
      throw err;
    }
  }

  private async findReplay(
    customerId: string,
    key: string,
    requestHash: string,
  ): Promise<OrderResult | undefined> {
    const record = await this.db.idempotencyRecord.findUnique({
      where: { customerId_key: { customerId, key } },
    });
    if (!record) return undefined;
    if (Date.now() - record.createdAt.getTime() > IDEMPOTENCY_TTL_MS) {
      await this.db.idempotencyRecord.delete({ where: { id: record.id } });
      return undefined;
    }
    if (record.requestHash !== requestHash) {
      throw problems.validation(
        [
          {
            pointer: '#/headers/idempotency-key',
            detail: 'Key was already used with a different request body',
          },
        ],
        'Idempotency-Key reuse with a different payload',
      );
    }
    return {
      status: record.responseStatus,
      body: record.responseBody as unknown as OrderDto,
      replayed: true,
    };
  }

  /** Ownership is part of the query itself (OWASP API1/BOLA): other customers' orders are 404. */
  async get(customerId: string, orderId: string): Promise<OrderDto> {
    const order = await this.db.order.findFirst({
      where: { id: orderId, customerId },
      include: { items: true },
    });
    if (!order) throw problems.notFound('Order');
    return this.toDto(order);
  }

  async list(customerId: string, limit: number, cursor: string | undefined) {
    const rows = await this.db.order.findMany({
      where: { AND: [{ customerId }, afterCursor(cursor)] },
      orderBy: keysetOrder,
      take: limit + 1,
      include: { items: true },
    });
    return page(rows, limit, (o) => this.toDto(o));
  }
}
