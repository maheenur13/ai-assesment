import { Router } from 'express';
import { customerIdOf, requireCustomer } from '../../http/auth.js';
import { paginationQuery } from '../../http/pagination.js';
import { problems } from '../../http/problem.js';
import { parse } from '../../http/validate.js';
import { idParam } from '../shared.js';
import { createOrderBody, idempotencyKeySchema } from './schemas.js';
import type { OrderService } from './service.js';

export function orderRoutes(orders: OrderService): Router {
  const router = Router();
  router.use(requireCustomer);

  router.post('/', async (req, res) => {
    const rawKey = req.get('Idempotency-Key');
    if (rawKey === undefined) throw problems.badRequest('The Idempotency-Key header is required.');
    const keyResult = idempotencyKeySchema.safeParse(rawKey);
    if (!keyResult.success) {
      throw problems.validation([
        {
          pointer: '#/headers/idempotency-key',
          detail: 'Must be 1-255 printable ASCII characters',
        },
      ]);
    }
    const key = keyResult.data;
    const customerId = customerIdOf(req.auth);
    const result = await orders.create(customerId, parse(createOrderBody, req.body, 'body'), key);
    req.log.info(
      { event: result.replayed ? 'order.replayed' : 'order.placed', orderId: result.body.id },
      'order request handled',
    );
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(result.status).location(`${req.baseUrl}/${result.body.id}`).json(result.body);
  });

  router.get('/', async (req, res) => {
    const { limit, cursor } = parse(paginationQuery.strict(), req.query, 'query');
    res.json(await orders.list(customerIdOf(req.auth), limit, cursor));
  });

  router.get('/:id', async (req, res) => {
    res.json(await orders.get(customerIdOf(req.auth), idParam(req.params.id, 'Order')));
  });

  return router;
}
