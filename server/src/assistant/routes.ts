import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../http/validate.js';
import { productSchema } from '../modules/products/schemas.js';
import type { AssistantService } from './service.js';

export const chatBody = z
  .object({
    conversationId: z.uuid().optional().describe('Omit to start a new conversation'),
    message: z.string().trim().min(1, 'Message must not be empty').max(2_000),
  })
  .strict()
  .meta({ id: 'ChatRequest' });

export const chatResponse = z
  .object({
    conversationId: z.uuid(),
    reply: z.string().describe('Plain text; render as text, never as HTML'),
    products: z
      .array(productSchema)
      .describe('Authoritative records of the products the assistant looked up in this turn'),
  })
  .meta({ id: 'ChatResponse' });

export function assistantRoutes(assistant: AssistantService): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const body = parse(chatBody, req.body, 'body');
    const customerId = req.auth?.role === 'customer' ? req.auth.customerId : null;
    try {
      res.json(await assistant.chat(body, { customerId }, req.log));
    } catch (err) {
      if ((err as { slug?: string }).slug === 'assistant-unavailable')
        res.setHeader('Retry-After', '30');
      throw err;
    }
  });

  return router;
}
