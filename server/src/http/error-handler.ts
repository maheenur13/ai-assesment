import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import { Problem, problems, type FieldError } from './problem.js';

export function sendProblem(res: Response, problem: Problem): void {
  res
    .status(problem.status)
    .type('application/problem+json')
    .json({
      type: problem.type,
      title: problem.title,
      status: problem.status,
      ...(problem.detail !== undefined && { detail: problem.detail }),
      instance: res.req.originalUrl,
      requestId: res.req.id,
      ...problem.extensions,
    });
}

/** Zod issue path → JSON Pointer (RFC 6901). `location` is `body` or `query`. */
export function toFieldErrors(error: ZodError, location: string): FieldError[] {
  return error.issues.map((issue) => ({
    pointer: `#/${[location, ...issue.path].map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`,
    detail: issue.message,
  }));
}

function fromKnownError(err: unknown): Problem | undefined {
  if (err instanceof Problem) return err;
  if (err instanceof ZodError) return problems.validation(toFieldErrors(err, 'body'));
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') return problems.conflict('duplicate', 'Resource already exists');
    if (err.code === 'P2025') return problems.notFound();
  }
  // body-parser errors carry a `type` discriminator.
  const type = (err as { type?: unknown }).type;
  if (type === 'entity.parse.failed') return problems.malformedJson();
  if (type === 'entity.too.large') return problems.payloadTooLarge();
  if (type === 'encoding.unsupported' || type === 'charset.unsupported') {
    return problems.unsupportedMediaType();
  }
  return undefined;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const problem = fromKnownError(err);
  if (problem) {
    if (problem.status >= 500) req.log.error({ err }, 'request failed');
    sendProblem(res, problem);
    return;
  }
  // Unknown error: log everything, reveal nothing (OWASP API8).
  req.log.error({ err }, 'unhandled error');
  sendProblem(res, new Problem(500, 'internal-error', 'Internal server error'));
};

export const notFoundHandler: RequestHandler = (_req, res) => {
  sendProblem(res, problems.notFound('Route'));
};

/** 415 for any request that carries a body which is not JSON. */
export const requireJsonBody: RequestHandler = (req, _res, next) => {
  const hasBody =
    req.headers['transfer-encoding'] !== undefined ||
    (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0');
  if (hasBody && !req.is('application/json')) {
    next(problems.unsupportedMediaType());
    return;
  }
  next();
};
