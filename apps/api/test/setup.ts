import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

loadEnv({ path: resolve(__dirname, '../.env') });

process.env.NODE_ENV = 'test';

const base = process.env.DATABASE_URL;
if (base) {
  const url = new URL(base);
  if (!url.pathname.endsWith('_test')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}_test`;
    process.env.DATABASE_URL = url.toString();
  }
}
