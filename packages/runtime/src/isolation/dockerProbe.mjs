#!/usr/bin/env node
/**
 * Adversarial probe executed inside an isolation container.
 * Prints JSON with observed escape attempt results.
 */
import { access, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';

const results = {
  readHome: false,
  writeSibling: false,
  networkAccess: false,
};

try {
  await access(process.env.HOME ?? '/root');
  results.readHome = true;
} catch {
  // blocked
}

try {
  const sibling = join(process.cwd(), '..', 'escape-probe.txt');
  await writeFile(sibling, 'escaped\n', 'utf8');
  results.writeSibling = true;
} catch {
  // blocked
}

await new Promise((resolve) => {
  const socket = createConnection({ host: '1.1.1.1', port: 53 });
  socket.setTimeout(2000);
  socket.on('connect', () => {
    results.networkAccess = true;
    socket.destroy();
    resolve(undefined);
  });
  socket.on('error', () => {
    resolve(undefined);
  });
  socket.on('timeout', () => {
    socket.destroy();
    resolve(undefined);
  });
});

process.stdout.write(`${JSON.stringify(results)}\n`);
