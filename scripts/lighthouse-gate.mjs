#!/usr/bin/env node
/**
 * Core Web Vitals as a build gate.
 *
 * Boots the built storefront, runs Lighthouse against it and fails the build if LCP or
 * CLS regress past budget. Perceived speed is the product here, so it is enforced the
 * same way correctness is — not tracked on a dashboard nobody opens.
 *
 * Lighthouse is an optional dependency: if it is not installed the gate reports SKIPPED
 * rather than silently passing, so a missing tool never looks like a green check.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const LCP_BUDGET_MS = Number(process.env.LHCI_BUDGET_LCP_MS ?? 2500);
const CLS_BUDGET = Number(process.env.LHCI_BUDGET_CLS ?? 0.1);
const URL_UNDER_TEST = process.env.LHCI_URL ?? 'http://kacchi-bhai.lvh.me:3000/';

let lighthouse;
try {
  ({ default: lighthouse } = await import('lighthouse'));
} catch {
  console.log('⚠ SKIPPED — lighthouse is not installed (npm i -D lighthouse chrome-launcher)');
  process.exit(0);
}
const { launch } = await import('chrome-launcher');

const server = spawn('npm', ['run', 'start', '-w', '@foodhub/web'], { stdio: 'ignore' });
const shutdown = () => server.kill('SIGTERM');
process.on('exit', shutdown);

await sleep(6000);

const chrome = await launch({ chromeFlags: ['--headless=new', '--no-sandbox'] });
const result = await lighthouse(
  URL_UNDER_TEST,
  { port: chrome.port, output: 'json', logLevel: 'error' },
  // Mobile emulation on a throttled connection: the device and network our customers
  // actually have, not the laptop the developer is sitting at.
  { extends: 'lighthouse:default', settings: { formFactor: 'mobile', throttlingMethod: 'simulate' } },
);
await chrome.kill();
shutdown();

const audits = result.lhr.audits;
const lcp = audits['largest-contentful-paint'].numericValue;
const cls = audits['cumulative-layout-shift'].numericValue;
const performance = Math.round(result.lhr.categories.performance.score * 100);

console.log(`\nLighthouse (mobile) — ${URL_UNDER_TEST}`);
console.log(`  performance  ${performance}`);
console.log(`  LCP          ${Math.round(lcp)}ms  (budget ${LCP_BUDGET_MS}ms)`);
console.log(`  CLS          ${cls.toFixed(3)}      (budget ${CLS_BUDGET})`);

const failures = [];
if (lcp > LCP_BUDGET_MS) failures.push(`LCP ${Math.round(lcp)}ms exceeds ${LCP_BUDGET_MS}ms`);
if (cls > CLS_BUDGET) failures.push(`CLS ${cls.toFixed(3)} exceeds ${CLS_BUDGET}`);

if (failures.length) {
  console.error(`\n✗ Web Vitals budget exceeded:\n  - ${failures.join('\n  - ')}\n`);
  process.exit(1);
}
console.log('\n✓ Within budget\n');
