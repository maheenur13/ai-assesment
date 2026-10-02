import { Router } from 'express';
import { customerIdOf, requireCustomer, requireOperator } from '../../http/auth.js';
import { parse } from '../../http/validate.js';
import { idParam } from '../shared.js';
import { createCustomerBody } from './schemas.js';
import type { CustomerService } from './service.js';

export function customerRoutes(customers: CustomerService): Router {
  const router = Router();

  router.post('/customers', requireOperator, async (req, res) => {
    const created = await customers.create(parse(createCustomerBody, req.body, 'body'));
    req.log.info(
      { event: 'customer.created', customerId: created.customer.id },
      'customer created',
    );
    res.status(201).location(`${req.baseUrl}/customers/${created.customer.id}`).json(created);
  });

  router.get('/customers/:id', requireOperator, async (req, res) => {
    res.json(await customers.get(idParam(req.params.id, 'Customer')));
  });

  router.get('/me', requireCustomer, async (req, res) => {
    res.json(await customers.get(customerIdOf(req.auth)));
  });

  return router;
}
