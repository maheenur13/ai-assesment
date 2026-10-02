import type { z } from 'zod';
import { problems } from './problem.js';
import { toFieldErrors } from './error-handler.js';

/** Parse untrusted input; on failure throw a 422 whose pointers name the input location. */
export function parse<S extends z.ZodType>(
  schema: S,
  input: unknown,
  location: 'body' | 'query' | 'params',
): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw problems.validation(toFieldErrors(result.error, location));
  return result.data;
}
