import { execSync } from 'node:child_process';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

/**
 * Tests run against their own database so a test run can never truncate the dev seed.
 * The URL is derived from DATABASE_URL by swapping the database name for `<name>_test`.
 */
export default function globalSetup() {
  loadEnv({ path: resolve(__dirname, '../.env') });

  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is not set — copy .env.example to .env first');

  const url = new URL(base);
  if (!url.pathname.endsWith('_test')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}_test`;
  }
  const testUrl = url.toString();
  process.env.DATABASE_URL = testUrl;
  process.env.NODE_ENV = 'test';

  // `migrate deploy` creates the database if it is missing and is a no-op once current.
  execSync('npx prisma migrate deploy', {
    cwd: resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'pipe',
  });
}
