import { z } from 'zod';
import { Problem } from '../http/problem.js';
import { createCustomerBody } from '../modules/customers/schemas.js';
import type { CustomerService } from '../modules/customers/service.js';
import { createOrderBody, type OrderDto, type ProposalDto } from '../modules/orders/schemas.js';
import type { OrderService } from '../modules/orders/service.js';
import type { ProductDto } from '../modules/products/schemas.js';
import type { ProductService } from '../modules/products/service.js';
import type { ToolSpec } from './llm.js';

/**
 * Tools the model may call. Each one validates its arguments with zod and delegates to a service;
 * nothing here touches the database directly (OWASP LLM06: no generic query/update tools).
 * Identity comes from `ToolContext` (the authenticated request), never from model arguments.
 * Services throw `Problem`s for business-rule failures; the agent hands those back to the model
 * as data (e.g. "insufficient stock"), so tools don't need to catch them.
 */
export interface ToolContext {
  /** The signed-in customer, or the guest of an anonymous conversation once they gave details. */
  customerId: string | null;
  conversationId: string;
  /** Number of completed turns in this conversation before the current one. */
  turn: number;
  /** The customer's own message in this turn (the model cannot change it). */
  userMessage: string;
}

/**
 * Deterministic check that the customer's message is an explicit "yes". Together with the
 * earlier-turn rule this means `confirm_order` needs the customer's own words: text injected into
 * tool results or history can steer the model, but it can't change what the customer typed.
 */
export function isExplicitConfirmation(message: string): boolean {
  return (
    /\b(yes|yep|yeah|yup|sure|ok|okay|confirm(ed)?|go ahead|place (it|that|the order|my order)|do it|buy it|order it|sounds good)\b/i.test(
      message,
    ) && !/\b(no|not|don'?t|cancel|wait|stop|hold on)\b/i.test(message)
  );
}

export interface ToolOutcome {
  /** What the model sees: minimal fields, serialised as JSON data. */
  result: unknown;
  /** Authoritative records surfaced to the client alongside the reply. */
  products?: ProductDto[];
  proposal?: ProposalDto;
  order?: OrderDto;
}

export interface Tool {
  description: string;
  args: z.ZodType;
  /** Offered to the model only in anonymous conversations. */
  guestOnly?: boolean;
  run(args: unknown, ctx: ToolContext): Promise<ToolOutcome>;
}

/** Typed at definition; the agent only calls `run` with output of `args.parse`. */
const defineTool = <S extends z.ZodType>(tool: {
  description: string;
  args: S;
  guestOnly?: boolean;
  run(args: z.infer<S>, ctx: ToolContext): Promise<ToolOutcome>;
}): Tool => tool;

const formatMoney = (m: { amount: number; currency: string }) =>
  `${(m.amount / 100).toFixed(2)} ${m.currency}`;
const formatPrice = (p: ProductDto) => formatMoney(p.price);

/** The model sees prices as formatted strings (no minor-unit confusion) and short descriptions. */
const forModel = (p: ProductDto, descriptionChars: number) => ({
  id: p.id,
  sku: p.sku,
  name: p.name,
  category: p.category,
  price: formatPrice(p),
  stock: p.stock,
  description: p.description.slice(0, descriptionChars),
});

export function catalogTools(products: ProductService): Record<string, Tool> {
  return {
    search_products: defineTool({
      description:
        'Search the store catalog by keywords. Returns up to 8 products, best match first, ' +
        'including out-of-stock ones (stock 0). Use short keywords (product type, brand, ' +
        'feature). An empty list means the store does not sell a match.',
      args: z
        .object({
          query: z.string().trim().min(1).max(200).describe('Keywords, e.g. "wireless earbuds"'),
          category: z.string().trim().min(1).max(100).optional().describe('Exact category name'),
          maxPrice: z
            .number()
            .positive()
            .max(1_000_000)
            .optional()
            .describe('Maximum price in major units, e.g. 50 for 50.00'),
        })
        .strict(),
      async run(args) {
        const found = await products.search(args.query, {
          category: args.category,
          maxPriceCents: args.maxPrice === undefined ? undefined : Math.round(args.maxPrice * 100),
        });
        return { result: { products: found.map((p) => forModel(p, 200)) }, products: found };
      },
    }),
    get_product: defineTool({
      description: 'Get full details of one product by the id returned from search_products.',
      args: z.object({ id: z.uuid() }).strict(),
      async run(args) {
        try {
          const product = await products.get(args.id);
          return { result: { product: forModel(product, 2_000) }, products: [product] };
        } catch (err) {
          if (err instanceof Problem && err.status === 404) {
            return { result: { error: 'No such product.' }, products: [] };
          }
          throw err;
        }
      },
    }),
    list_categories: defineTool({
      description: 'List the product categories the store sells, with product counts.',
      args: z.object({}).strict(),
      async run() {
        return { result: { categories: await products.categories() }, products: [] };
      },
    }),
  };
}

const linesForModel = (items: OrderDto['items']) =>
  items.map((i) => ({
    productName: i.productName,
    quantity: i.quantity,
    unitPrice: formatMoney(i.unitPrice),
    lineTotal: formatMoney(i.lineTotal),
  }));

const orderForModel = (o: OrderDto) => ({
  id: o.id,
  status: o.status,
  placedAt: o.createdAt,
  total: formatMoney(o.total),
  items: linesForModel(o.items),
});

/** A guest who hasn't given checkout details yet has no orders and cannot order. */
function customerOf(ctx: ToolContext): string {
  if (ctx.customerId === null) {
    throw new Problem(
      403,
      'guest-details-required',
      'Checkout details required',
      'Ask the customer for their name and email address, then call set_guest_details.',
    );
  }
  return ctx.customerId;
}

/**
 * Order tools. Every call is scoped to `ctx.customerId` by the service: the signed-in customer,
 * or the guest of this anonymous conversation (who only ever sees orders made in it).
 */
export function orderTools(orders: OrderService, customers: CustomerService): Record<string, Tool> {
  return {
    set_guest_details: defineTool({
      description:
        'Guest checkout: save the name and email address the customer gave you in this chat. ' +
        'Required once before a guest can order. Never ask for passwords or tokens.',
      args: createCustomerBody,
      guestOnly: true,
      async run(args, ctx) {
        // The conversation is saved with this guest at the end of the turn.
        ctx.customerId = await customers.saveGuest(args, ctx.customerId);
        return { result: { saved: true, name: args.name } };
      },
    }),
    list_my_orders: defineTool({
      description:
        "List the customer's 10 most recent orders, newest first. For a guest: only the " +
        'orders placed in this conversation.',
      args: z.object({}).strict(),
      async run(_args, ctx) {
        const { data } = await orders.list(customerOf(ctx), 10, undefined);
        return { result: { orders: data.map(orderForModel) } };
      },
    }),
    get_my_order: defineTool({
      description: "Get one of the customer's orders by its id.",
      args: z.object({ id: z.uuid() }).strict(),
      async run(args, ctx) {
        const order = await orders.get(customerOf(ctx), args.id);
        return { result: { order: orderForModel(order) } };
      },
    }),
    propose_order: defineTool({
      description:
        'Prepare an order for the customer to review. Does NOT place it. Use product ids from ' +
        'search_products. Returns the proposal with server-calculated prices and total; show ' +
        'these to the customer and ask them to confirm.',
      args: createOrderBody,
      async run(args, ctx) {
        const proposal = await orders.propose(customerOf(ctx), ctx, args);
        return {
          result: {
            proposal: {
              id: proposal.id,
              items: linesForModel(proposal.items),
              total: formatMoney(proposal.total),
              expiresAt: proposal.expiresAt,
            },
          },
          proposal,
        };
      },
    }),
    confirm_order: defineTool({
      description:
        'Place a proposed order. Only call this after the customer has explicitly confirmed ' +
        'that exact proposal in a message after it was shown to them.',
      args: z.object({ proposalId: z.uuid() }).strict(),
      async run(args, ctx) {
        if (!isExplicitConfirmation(ctx.userMessage)) {
          throw new Problem(
            409,
            'confirmation-required',
            'Confirmation required',
            'The customer has not confirmed in this message. Show the proposal and ask them to confirm.',
          );
        }
        const { body } = await orders.confirmProposal(customerOf(ctx), args.proposalId, ctx);
        return { result: { placedOrder: orderForModel(body) }, order: body };
      },
    }),
  };
}

export function toolSpecs(tools: Record<string, Tool>): ToolSpec[] {
  return Object.entries(tools).map(([name, tool]) => ({
    type: 'function',
    function: {
      name,
      description: tool.description,
      // The model sends input; `io: 'input'` also describes schemas that have transforms.
      parameters: z.toJSONSchema(tool.args, { io: 'input' }),
    },
  }));
}
