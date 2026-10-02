import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  createCustomerBody,
  createdCustomerSchema,
  customerSchema,
} from './modules/customers/schemas.js';
import { createOrderBody, guestConfirmBody, orderSchema } from './modules/orders/schemas.js';
import {
  createProductBody,
  listProductsQuery,
  productSchema,
  updateProductBody,
} from './modules/products/schemas.js';
import { paginationQuery } from './http/pagination.js';
import { chatBody, chatResponse } from './assistant/routes.js';
import { createImportBody, importRunSchema } from './importer/routes.js';

/** OpenAPI 3.1 document generated from the same zod schemas that validate requests. */
export function buildOpenApiDocument(): unknown {
  const registry = new OpenAPIRegistry();
  const bearer = registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
  });
  const secured = [{ [bearer.name]: [] }];

  const problem = z
    .object({
      type: z.string(),
      title: z.string(),
      status: z.number().int(),
      detail: z.string().optional(),
      instance: z.string().optional(),
      requestId: z.string().optional(),
      errors: z.array(z.object({ pointer: z.string(), detail: z.string() })).optional(),
    })
    .meta({ id: 'Problem' });
  const problemResponse = (description: string) => ({
    description,
    content: { 'application/problem+json': { schema: problem } },
  });
  const json = <T extends z.ZodType>(schema: T, description: string) => ({
    description,
    content: { 'application/json': { schema } },
  });
  const pageOf = <T extends z.ZodType>(item: T) =>
    z.object({ data: z.array(item), nextCursor: z.string().optional() });
  const idParams = z.object({ id: z.uuid() });
  const errors = {
    401: problemResponse('Missing or invalid token'),
    422: problemResponse('Validation failed'),
    429: problemResponse('Rate limited'),
  };

  registry.registerPath({
    method: 'get',
    path: '/api/v1/products',
    summary: 'List or search active products',
    request: { query: listProductsQuery },
    responses: { 200: json(pageOf(productSchema), 'A page of products'), 422: errors[422] },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/products/{id}',
    summary: 'Get a product',
    request: { params: idParams },
    responses: { 200: json(productSchema, 'The product'), 404: problemResponse('Not found') },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/products',
    summary: 'Create a product (operator)',
    security: secured,
    request: { body: { content: { 'application/json': { schema: createProductBody } } } },
    responses: {
      201: json(productSchema, 'Created'),
      ...errors,
      403: problemResponse('Not an operator'),
      409: problemResponse('Duplicate SKU'),
    },
  });
  registry.registerPath({
    method: 'patch',
    path: '/api/v1/products/{id}',
    summary: 'Update a product (operator, merge-patch semantics)',
    security: secured,
    request: {
      params: idParams,
      body: { content: { 'application/json': { schema: updateProductBody } } },
    },
    responses: {
      200: json(productSchema, 'Updated'),
      ...errors,
      404: problemResponse('Not found'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/customers',
    summary: 'Register a customer and issue an API token (operator)',
    security: secured,
    request: { body: { content: { 'application/json': { schema: createCustomerBody } } } },
    responses: {
      201: json(createdCustomerSchema, 'Created; the token is shown only once'),
      ...errors,
      409: problemResponse('Email already registered'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/customers/{id}',
    summary: 'Get a customer (operator)',
    security: secured,
    request: { params: idParams },
    responses: { 200: json(customerSchema, 'The customer'), 404: problemResponse('Not found') },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/me',
    summary: 'The authenticated customer',
    security: secured,
    responses: { 200: json(customerSchema, 'The customer'), 401: errors[401] },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/orders',
    summary: 'Place an order (customer)',
    security: secured,
    request: {
      headers: z.object({ 'idempotency-key': z.string().meta({ example: crypto.randomUUID() }) }),
      body: { content: { 'application/json': { schema: createOrderBody } } },
    },
    responses: {
      201: json(orderSchema, 'Placed (or replayed for a repeated Idempotency-Key)'),
      400: problemResponse('Missing Idempotency-Key'),
      ...errors,
      409: problemResponse('Insufficient stock'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/orders',
    summary: "List the caller's orders",
    security: secured,
    request: { query: paginationQuery },
    responses: { 200: json(pageOf(orderSchema), 'A page of orders'), 401: errors[401] },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/orders/{id}',
    summary: "Get one of the caller's orders",
    security: secured,
    request: { params: idParams },
    responses: { 200: json(orderSchema, 'The order'), 404: problemResponse('Not found') },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/order-proposals/{id}/confirm',
    summary: 'Confirm an order the assistant proposed (customer or guest)',
    description:
      'Places the order at the proposed prices after re-checking stock and availability. ' +
      'Single-use: repeating the call returns the same order (`Idempotent-Replayed: true`). ' +
      'Customers send their bearer token and no body. Guests (no token) send the id of the ' +
      'anonymous conversation the order was proposed in.',
    security: [{}, ...secured],
    request: {
      params: idParams,
      body: {
        required: false,
        content: { 'application/json': { schema: guestConfirmBody } },
      },
    },
    responses: {
      201: json(orderSchema, 'Placed (or replayed if already confirmed)'),
      403: problemResponse('Operator token'),
      422: errors[422],
      404: problemResponse("Unknown proposal or another customer's"),
      409: problemResponse(
        'Expired, price changed, product no longer available, or insufficient stock',
      ),
      429: errors[429],
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/chat',
    summary: 'Ask the shopping assistant (anonymous or customer)',
    description:
      'Answers come only from tools. With a customer token the assistant can also list the ' +
      "customer's orders and propose an order, which is placed only after confirmation. " +
      "Conversations are bound to the caller: an anonymous conversation can't be continued " +
      'with a customer token and vice versa.',
    security: [{}, ...secured],
    request: { body: { content: { 'application/json': { schema: chatBody } } } },
    responses: {
      200: json(chatResponse, 'The reply and the products it is based on'),
      404: problemResponse('Unknown conversation'),
      409: problemResponse('Concurrent message on the same conversation'),
      422: errors[422],
      429: errors[429],
      503: problemResponse('Assistant not configured or model provider unavailable'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/imports',
    summary: 'Bulk import products from a link (operator)',
    description:
      'Downloads a CSV/JSON file (or a Google Sheet shared by link), maps its columns, validates ' +
      'every row like POST /products and upserts by SKU. Invalid rows are reported, valid rows ' +
      'imported. `dryRun` (default true) reports what would change without writing products.',
    security: secured,
    request: { body: { content: { 'application/json': { schema: createImportBody } } } },
    responses: {
      201: json(importRunSchema, 'The import report'),
      ...errors,
      403: problemResponse('Not an operator'),
      422: problemResponse(
        'Invalid request, URL not allowed, unreadable file or required columns not found',
      ),
      502: problemResponse('The file could not be downloaded'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/imports/{id}',
    summary: 'Get an import report (operator)',
    security: secured,
    request: { params: idParams },
    responses: {
      200: json(importRunSchema, 'The import report'),
      401: errors[401],
      403: problemResponse('Not an operator'),
      404: problemResponse('Not found'),
    },
  });

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: { title: 'BluBird Shop API', version: '1.0.0' },
  });
}
