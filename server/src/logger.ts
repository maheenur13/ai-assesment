import { pino, type Logger } from 'pino';

export type { Logger };

/** Structured JSON logs. Credentials are redacted; request/response bodies are never logged. */
export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[redacted]',
    },
  });
}
