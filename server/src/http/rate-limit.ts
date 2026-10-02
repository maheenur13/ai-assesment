import type { Request } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { problems } from './problem.js';

/** Key by authenticated identity when present, otherwise by (IPv6-subnet-masked) client IP. */
function keyOf(req: Request): string {
  if (req.auth?.role === 'customer') return `customer:${req.auth.customerId}`;
  if (req.auth?.role === 'operator') return 'operator';
  return `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
}

export function createRateLimiter(limitPerMinute: number, name: string) {
  return rateLimit({
    windowMs: 60_000,
    limit: limitPerMinute,
    standardHeaders: 'draft-8',
    identifier: name,
    legacyHeaders: false,
    keyGenerator: keyOf,
    handler: (req, _res, next) => {
      req.log.warn({ event: 'rate_limited', limiter: name }, 'rate limit exceeded');
      next(problems.tooManyRequests());
    },
  });
}
