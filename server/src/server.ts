import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const db = createDb(config.DATABASE_URL);
const app = createApp({ config, db, logger });

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'server listening');
});
// Bound slow clients (OWASP API4); Node defaults are 300s / 60s.
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down');
  app.locals['shuttingDown'] = true;
  const force = setTimeout(() => {
    logger.error('forced exit after shutdown timeout');
    process.exit(1);
  }, 10_000);
  force.unref();
  server.close(() => {
    void db.$disconnect().finally(() => process.exit(0));
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
