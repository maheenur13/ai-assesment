import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { apiReference } from '@scalar/express-api-reference';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { OpenAiCompatibleLlm, type Llm } from './assistant/llm.js';
import { assistantRoutes } from './assistant/routes.js';
import { AssistantService } from './assistant/service.js';
import { catalogTools, orderTools } from './assistant/tools.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { authenticate } from './http/auth.js';
import { errorHandler, notFoundHandler, requireJsonBody } from './http/error-handler.js';
import { createRateLimiter } from './http/rate-limit.js';
import type { Logger } from './logger.js';
import { customerRoutes } from './modules/customers/routes.js';
import { CustomerService } from './modules/customers/service.js';
import { orderRoutes, proposalRoutes } from './modules/orders/routes.js';
import { OrderService } from './modules/orders/service.js';
import { productRoutes } from './modules/products/routes.js';
import { ProductService } from './modules/products/service.js';
import { buildOpenApiDocument } from './openapi.js';

export interface AppDeps {
  config: Config;
  db: Db;
  logger: Logger;
  /** Overrides the configured model client (tests inject a scripted fake). */
  llm?: Llm;
}

const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function createApp({ config, db, logger, llm }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.locals['shuttingDown'] = false;

  app.use(
    pinoHttp({
      logger,
      // Reuse a well-formed upstream request id, otherwise mint one; always echo it back.
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id =
          typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      customProps: (req) => ({ principal: req.auth?.role ?? 'anonymous' }),
      // Log the minimum needed to trace a request; headers and bodies are deliberately omitted.
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  // Health endpoints sit outside auth and rate limits. Liveness never touches the DB.
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/readyz', async (_req, res) => {
    if (app.locals['shuttingDown'] === true) {
      res.status(503).json({ status: 'shutting-down' });
      return;
    }
    try {
      await db.$queryRaw`SELECT 1`;
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'database-unavailable' });
    }
  });

  // API docs: the reference UI loads assets from a CDN, so it gets its own relaxed CSP.
  const openApiDocument = buildOpenApiDocument();
  app.get('/api/v1/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });
  app.use(
    '/docs',
    helmet({
      contentSecurityPolicy: {
        directives: {
          scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
          connectSrc: ["'self'"],
        },
      },
    }),
    // Pinned: the browser only ever runs a known version of the reference UI from the CDN.
    apiReference({
      url: '/api/v1/openapi.json',
      cdn: 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.4',
    }),
  );

  // The app is served over plain HTTP (docker compose / localhost); `upgrade-insecure-requests`
  // would make Safari fetch the UI's assets over https and break the page.
  app.use(helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } } }));
  app.use(express.json({ limit: '100kb' }));

  const api = express.Router();
  api.use(requireJsonBody);
  // Pre-auth limit by IP throttles token guessing before any DB lookup happens.
  api.use(createRateLimiter(config.RATE_LIMIT_PER_MINUTE, 'ip'));
  api.use(authenticate(db, config.OPERATOR_TOKEN));
  api.use(createRateLimiter(config.RATE_LIMIT_PER_MINUTE, 'global'));

  const products = new ProductService(db, config.STORE_CURRENCY);
  const customers = new CustomerService(db);
  const orders = new OrderService(db, config.STORE_CURRENCY);
  const model =
    llm ??
    (config.OPENAI_API_KEY === undefined
      ? undefined
      : new OpenAiCompatibleLlm({
          apiKey: config.OPENAI_API_KEY,
          baseUrl: config.OPENAI_BASE_URL,
          model: config.LLM_MODEL,
        }));
  const assistant = new AssistantService(
    db,
    model,
    { ...catalogTools(products), ...orderTools(orders, customers) },
    {
      timeoutMs: config.LLM_TIMEOUT_MS,
    },
  );

  // Placing orders directly and confirming proposals share one budget.
  const orderLimiter = createRateLimiter(config.ORDER_RATE_LIMIT_PER_MINUTE, 'orders');
  api.use('/products', productRoutes(products));
  api.use('/orders', orderLimiter, orderRoutes(orders));
  api.use('/order-proposals', orderLimiter, proposalRoutes(orders));
  api.use(
    '/chat',
    createRateLimiter(config.CHAT_RATE_LIMIT_PER_MINUTE, 'chat'),
    assistantRoutes(assistant),
  );
  api.use('/', customerRoutes(customers));
  app.use('/api/v1', api);
  // The chat UI (web/, built by `pnpm build`). Same origin as the API, under the default CSP.
  app.use(express.static(resolve('web/dist')));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
