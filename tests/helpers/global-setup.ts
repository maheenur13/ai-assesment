import { execFileSync } from 'node:child_process';

/** Applies migrations to the dedicated test database once per run. */
export default function setup(): void {
  try {
    process.loadEnvFile();
  } catch {
    // CI provides env directly.
  }
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) throw new Error('TEST_DATABASE_URL must be set (see .env.example)');
  if (!/\/shop_test(\?|$)/.test(url))
    throw new Error('Refusing to run tests against a non-test DB');
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
}
