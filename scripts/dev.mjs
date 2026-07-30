#!/usr/bin/env node
/**
 * One command to run the whole platform locally: API + web + admin, with prefixed,
 * colour-coded logs and a single Ctrl-C that actually stops everything.
 *
 * Ports are checked first — a stale process holding :4000 is otherwise very easy to
 * mistake for "my code change did nothing".
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SERVICES = [
  { name: 'api', cwd: 'apps/api', cmd: 'npm', args: ['run', 'dev'], port: 4000, color: '\x1b[36m' },
  { name: 'web', cwd: 'apps/web', cmd: 'npm', args: ['run', 'dev'], port: 3000, color: '\x1b[35m' },
  { name: 'admin', cwd: 'apps/admin', cmd: 'npm', args: ['run', 'dev'], port: 3001, color: '\x1b[33m' },
];

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

function portInUse(port) {
  return new Promise((res) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.on('connect', () => {
      socket.destroy();
      res(true);
    });
    socket.on('error', () => res(false));
    setTimeout(() => {
      socket.destroy();
      res(false);
    }, 400);
  });
}

const busy = [];
for (const service of SERVICES) {
  if (await portInUse(service.port)) busy.push(service);
}
if (busy.length) {
  console.error(
    `\nPort${busy.length > 1 ? 's' : ''} already in use: ${busy.map((s) => `${s.port} (${s.name})`).join(', ')}\n` +
      `Stop the old process first:  lsof -ti:${busy.map((s) => s.port).join(',')} | xargs kill\n`,
  );
  process.exit(1);
}

console.log(`${DIM}Starting FoodHub…${RESET}`);

const children = SERVICES.map((service) => {
  const child = spawn(service.cmd, service.args, {
    cwd: resolve(root, service.cwd),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = `${service.color}${service.name.padEnd(5)}${RESET} ${DIM}│${RESET} `;
  const pipe = (stream) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) console.log(prefix + line);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);

  child.on('exit', (code) => {
    console.log(`${prefix}exited with code ${code}`);
  });

  return child;
});

setTimeout(() => {
  console.log(`
${DIM}────────────────────────────────────────────────────────${RESET}
  Marketplace   http://lvh.me:3000
  Storefronts   http://kacchi-bhai.lvh.me:3000
                http://pizza-shack.lvh.me:3000
                http://chai-adda.lvh.me:3000
  Vendor admin  http://lvh.me:3001
  API           http://127.0.0.1:4000/api
${DIM}────────────────────────────────────────────────────────${RESET}
`);
}, 6000);

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  console.log(`\n${DIM}Shutting down…${RESET}`);
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
    process.exit(0);
  }, 3000);
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
