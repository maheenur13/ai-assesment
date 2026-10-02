import { Router } from 'express';
import { requireOperator } from '../../http/auth.js';
import { parse } from '../../http/validate.js';
import { idParam } from '../shared.js';
import { createProductBody, listProductsQuery, updateProductBody } from './schemas.js';
import type { ProductService } from './service.js';

export function productRoutes(products: ProductService): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const query = parse(listProductsQuery, req.query, 'query');
    res.json(await products.list(query, req.auth?.role === 'operator'));
  });

  router.get('/:id', async (req, res) => {
    const id = idParam(req.params.id, 'Product');
    res.json(await products.get(id, req.auth?.role === 'operator'));
  });

  router.post('/', requireOperator, async (req, res) => {
    const product = await products.create(parse(createProductBody, req.body, 'body'));
    req.log.info({ event: 'product.created', productId: product.id }, 'product created');
    res.status(201).location(`${req.baseUrl}/${product.id}`).json(product);
  });

  router.patch('/:id', requireOperator, async (req, res) => {
    const id = idParam(req.params.id, 'Product');
    res.json(await products.update(id, parse(updateProductBody, req.body, 'body')));
  });

  return router;
}
