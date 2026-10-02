import { defineConfig } from 'prisma/config';

// Prisma 7 no longer reads .env itself; use Node's built-in loader for local runs.
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment (Docker, CI).
}

export default defineConfig({
  schema: 'server/prisma/schema.prisma',
  migrations: {
    path: 'server/prisma/migrations',
    seed: 'tsx server/src/seed.ts',
  },
  datasource: {
    // Only needed by migrate commands; `prisma generate` works without it.
    url: process.env['DATABASE_URL'] ?? '',
  },
});
