import { createHash } from 'node:crypto';
import type { Db } from '../../db.js';
import {
  Prisma,
  type Order,
  type OrderItem,
  type OrderProposal,
} from '../../generated/prisma/client.js';
import { afterCursor, keysetOrder, page } from '../../http/pagination.js';
import { Problem, problems } from '../../http/problem.js';
import { toMoney } from '../shared.js';
import type { CreateOrderInput, OrderDto, ProposalDto } from './schemas.js';

/** Replays older than this are treated as new requests (the draft leaves retention to servers). */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** How long the customer has to confirm an order the assistant proposed. */
export const PROPOSAL_TTL_MS = 15 * 60 * 1000;

type OrderWithItems = Order & { items: OrderItem[] };
type Line = Pick<OrderItem, 'productId' | 'productName' | 'unitPriceCents' | 'quantity'>;

/** The chat turn a proposal is made in (and, for `confirm_order`, the turn confirming it). */
export interface ChatConfirmation {
  conversationId: string;
  /** The current turn; the assistant may only confirm proposals from earlier turns. */
  turn: number;
}

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

  private lineDto(i: Line) {
    const c = this.currency;
    return {
      productId: i.productId,
      productName: i.productName,
      unitPrice: toMoney(i.unitPriceCents, c),
      quantity: i.quantity,
      lineTotal: toMoney(i.unitPriceCents * i.quantity, c),
    };
  }

  toDto(order: OrderWithItems): OrderDto {
    return {
      id: order.id,
      status: order.status,
      items: order.items.map((i) => this.lineDto(i)),
      total: toMoney(order.totalCents, this.currency),
      createdAt: order.createdAt.toISOString(),
    };
  }

  proposalDto(p: OrderProposal): ProposalDto {
    return {
      id: p.id,
      status: p.status,
      items: (p.items as unknown as Line[]).map((i) => this.lineDto(i)),
      total: toMoney(p.totalCents, this.currency),
      expiresAt: p.expiresAt.toISOString(),
      ...(p.orderId !== null && { orderId: p.orderId }),
    };
  }

  /**
   * Places an order atomically: validates products, decrements stock with a conditional update
   * (no oversell under concurrency), snapshots prices, and records the idempotent response in the
   * same transaction. A concurrent duplicate blocks on the unique (customer, key) index and rolls
   * back, after which it replays the committed response.
   * `expectedPrices` (productId → cents) makes the order fail with 409 if a price has changed,
   * so a confirmed proposal never charges more than the customer agreed to.
   */
  async create(
    customerId: string,
    input: CreateOrderInput,
    key: string,
    expectedPrices?: ReadonlyMap<string, number>,
  ): Promise<OrderResult> {
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
        if (
          expectedPrices &&
          input.items.some(
            (i) => byId.get(i.productId)?.priceCents !== expectedPrices.get(i.productId),
          )
        ) {
          throw problems.conflict(
            'price-changed',
            'Price changed',
            'A price changed after the order was proposed. Ask for a new proposal.',
          );
        }

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

  /**
   * Prices and validates an order without placing it or reserving stock. The proposal is bound to
   * the customer and the conversation and expires after PROPOSAL_TTL_MS.
   */
  async propose(
    customerId: string,
    chat: ChatConfirmation,
    input: CreateOrderInput,
  ): Promise<ProposalDto> {
    const products = await this.db.product.findMany({
      where: { id: { in: input.items.map((i) => i.productId) }, isActive: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    const lines: Line[] = [];
    for (const [index, item] of input.items.entries()) {
      const p = byId.get(item.productId);
      if (!p) {
        throw problems.validation([
          { pointer: `#/items/${index}/productId`, detail: 'Unknown or unavailable product' },
        ]);
      }
      if (p.stock < item.quantity) {
        throw problems.conflict(
          'insufficient-stock',
          'Insufficient stock',
          `Only ${p.stock} of ${p.name} in stock.`,
          { productId: p.id, available: p.stock },
        );
      }
      lines.push({
        productId: p.id,
        productName: p.name,
        unitPriceCents: p.priceCents,
        quantity: item.quantity,
      });
    }
    const proposal = await this.db.orderProposal.create({
      data: {
        customerId,
        conversationId: chat.conversationId,
        createdTurn: chat.turn,
        items: lines,
        totalCents: lines.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0),
        expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
      },
    });
    return this.proposalDto(proposal);
  }

  /**
   * Turns a pending proposal into an order. Single-use: the order is created under an internal
   * idempotency key derived from the proposal, so double clicks and concurrent confirmations
   * all get the same order. Price, stock and availability are re-checked at this moment.
   * `chat` is set when the assistant confirms on the customer's behalf: the proposal must then
   * belong to that conversation and come from an earlier turn, so a model turn (for example one
   * steered by injected text) can never propose and confirm by itself.
   */
  async confirmProposal(
    customerId: string,
    proposalId: string,
    chat?: { conversationId: string; turn?: number },
  ): Promise<OrderResult> {
    const proposal = await this.db.orderProposal.findFirst({
      where: { id: proposalId, customerId, ...(chat && { conversationId: chat.conversationId }) },
    });
    if (!proposal) throw problems.notFound('Order proposal');
    if (proposal.orderId !== null) {
      return { status: 201, body: await this.get(customerId, proposal.orderId), replayed: true };
    }
    if (chat?.turn !== undefined && proposal.createdTurn >= chat.turn) {
      throw problems.conflict(
        'confirmation-required',
        'Confirmation required',
        'Show the proposal to the customer and wait for them to confirm it in their next message.',
      );
    }
    if (proposal.expiresAt.getTime() <= Date.now()) {
      throw problems.conflict(
        'proposal-expired',
        'Proposal expired',
        'This proposal has expired. Ask for a new one.',
      );
    }

    const lines = proposal.items as unknown as Line[];
    let result: OrderResult;
    try {
      result = await this.create(
        customerId,
        { items: lines.map((l) => ({ productId: l.productId, quantity: l.quantity })) },
        // A space is outside the Idempotency-Key header charset, so clients can't collide with it.
        `proposal ${proposal.id}`,
        new Map(lines.map((l) => [l.productId, l.unitPriceCents])),
      );
    } catch (err) {
      if (err instanceof Problem && err.status === 422) {
        throw problems.conflict(
          'proposal-invalid',
          'Proposal no longer valid',
          'A product in this proposal is no longer available. Ask for a new proposal.',
        );
      }
      throw err;
    }
    await this.db.orderProposal.updateMany({
      where: { id: proposal.id, orderId: null },
      data: { status: 'placed', orderId: result.body.id },
    });
    return result;
  }

  /**
   * A guest's click on Confirm. Guests have no token: holding the anonymous conversation id (an
   * unguessable UUID returned only to the chat client) is what proves it's them, exactly as for
   * continuing that conversation. The proposal must belong to the conversation's guest and to that
   * conversation. Anything else is a 404.
   */
  async confirmGuestProposal(conversationId: string, proposalId: string): Promise<OrderResult> {
    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, customerId: null },
      select: { guestCustomerId: true },
    });
    if (!conversation?.guestCustomerId) throw problems.notFound('Order proposal');
    return this.confirmProposal(conversation.guestCustomerId, proposalId, { conversationId });
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
