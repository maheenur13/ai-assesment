import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Db } from '../db.js';
import { problems } from './problem.js';

export type Principal = { role: 'operator' } | { role: 'customer'; customerId: string };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: Principal;
    }
  }
}

const TOKEN_PREFIX = 'shop_';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 256-bit opaque token; the prefix makes leaked tokens easy to spot in secret scanners. */
export function generateCustomerToken(): { token: string; hash: string; prefix: string } {
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token), prefix: token.slice(0, 12) };
}

/**
 * Resolves `Authorization: Bearer <token>` into `req.auth`. Missing header → anonymous.
 * A header that is present but invalid → 401 (never silently downgraded to anonymous).
 */
export function authenticate(db: Db, operatorToken: string): RequestHandler {
  const operatorHash = Buffer.from(hashToken(operatorToken), 'hex');
  return async (req, res, next) => {
    const header = req.headers.authorization;
    if (header === undefined) {
      next();
      return;
    }
    const match = /^Bearer ([\x21-\x7e]{1,256})$/.exec(header);
    if (!match?.[1]) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      next(problems.unauthorized());
      return;
    }
    const hash = hashToken(match[1]);
    // Constant-time comparison of equal-length digests (no timing or length leak).
    if (timingSafeEqual(Buffer.from(hash, 'hex'), operatorHash)) {
      req.auth = { role: 'operator' };
      next();
      return;
    }
    const customer = await db.customer.findUnique({
      where: { tokenHash: hash },
      select: { id: true },
    });
    if (!customer) {
      req.log.warn({ event: 'auth.failed' }, 'invalid bearer token');
      res.setHeader('WWW-Authenticate', 'Bearer');
      next(problems.unauthorized());
      return;
    }
    req.auth = { role: 'customer', customerId: customer.id };
    next();
  };
}

function requireRole(role: Principal['role']): RequestHandler {
  return (req, res, next) => {
    if (!req.auth) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      next(problems.unauthorized());
      return;
    }
    if (req.auth.role !== role) {
      req.log.warn({ event: 'authz.denied', role: req.auth.role, need: role }, 'forbidden');
      next(problems.forbidden());
      return;
    }
    next();
  };
}

export const requireOperator = requireRole('operator');
export const requireCustomer = requireRole('customer');

/** Narrowing helper for handlers mounted behind `requireCustomer`. */
export function customerIdOf(auth: Principal | undefined): string {
  if (auth?.role !== 'customer') throw problems.unauthorized();
  return auth.customerId;
}
