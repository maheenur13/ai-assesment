import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  OPERATOR_TOKEN: z.string().min(32, 'OPERATOR_TOKEN must be at least 32 characters'),
  STORE_CURRENCY: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default('USD'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  ORDER_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(30),
});

export type Config = z.infer<typeof configSchema>;

/** Parse and validate the environment once at startup; fail fast with a readable message. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return result.data;
}
