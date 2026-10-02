import { z } from 'zod';
import { Problem } from '../http/problem.js';
import type { ProductDto } from '../modules/products/schemas.js';
import type { ProductService } from '../modules/products/service.js';
import type { ToolSpec } from './llm.js';

/**
 * Tools the model may call. Each one validates its arguments with zod and delegates to a service;
 * nothing here touches the database directly (OWASP LLM06: no generic query/update tools).
 * Identity, when tools need it (Task 2), comes from `ToolContext`, never from model arguments.
 */
export interface ToolContext {
  customerId: string | null;
}

export interface ToolOutcome {
  /** What the model sees: minimal fields, serialised as JSON data. */
  result: unknown;
  /** Authoritative product records surfaced to the client alongside the reply. */
  products: ProductDto[];
}

export interface Tool {
  description: string;
  args: z.ZodType;
  run(args: unknown, ctx: ToolContext): Promise<ToolOutcome>;
}

/** Typed at definition; the agent only calls `run` with output of `args.parse`. */
const defineTool = <S extends z.ZodType>(tool: {
  description: string;
  args: S;
  run(args: z.infer<S>, ctx: ToolContext): Promise<ToolOutcome>;
}): Tool => tool;

const formatPrice = (p: ProductDto) => `${(p.price.amount / 100).toFixed(2)} ${p.price.currency}`;

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

export function toolSpecs(tools: Record<string, Tool>): ToolSpec[] {
  return Object.entries(tools).map(([name, tool]) => ({
    type: 'function',
    function: { name, description: tool.description, parameters: z.toJSONSchema(tool.args) },
  }));
}
