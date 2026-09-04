#!/usr/bin/env node
/**
 * Adversarial probe executed inside an isolation container.
 * Prints a single JSON line with observed escape-attempt results. Every field is derived from
 * what the process could actually do; nothing is inferred from flags.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';

const results = {
  homeEnv: process.env.HOME ?? '',
  homeIsTmpfs: false,
  homeWritable: false,
  writeSibling: false,
  writeRootFs: false,
  networkAccess: false,
  bindMounts: [],
};

const VIRTUAL_FS_TYPES = new Set([
  'proc',
  'sysfs',
  'tmpfs',
  'devpts',
  'mqueue',
  'cgroup',
  'cgroup2',
  'overlay',
  'shm',
  'devtmpfs',
  'securityfs',
  'pstore',
  'bpf',
  'debugfs',
  'tracefs',
  'configfs',
  'fusectl',
  'nsfs',
  'binfmt_misc',
  'rootfs',
]);

try {
  const mounts = await readFile('/proc/mounts', 'utf8');
  let bestMatch = { mountPoint: '', fsType: '' };
  for (const line of mounts.split('\n')) {
    const parts = line.split(' ');
    if (parts.length < 3) {
      continue;
    }
    const mountPoint = parts[1].replace(/\\040/g, ' ');
    const fsType = parts[2];
    if (
      results.homeEnv.length > 0 &&
      (results.homeEnv === mountPoint || results.homeEnv.startsWith(`${mountPoint}/`)) &&
      mountPoint.length >= bestMatch.mountPoint.length
    ) {
      bestMatch = { mountPoint, fsType };
    }
    if (mountPoint !== '/' && !VIRTUAL_FS_TYPES.has(fsType) && !mountPoint.startsWith('/proc/')) {
      results.bindMounts.push(mountPoint);
    }
  }
  results.homeIsTmpfs = bestMatch.fsType === 'tmpfs';
} catch {
  // /proc/mounts unreadable: leave homeIsTmpfs=false (fail closed)
}

try {
  if (results.homeEnv.length > 0) {
    await mkdir(results.homeEnv, { recursive: true });
    await writeFile(join(results.homeEnv, 'ael-home-write.txt'), 'ok\n', 'utf8');
    results.homeWritable = true;
  }
} catch {
  // home not writable
}

try {
  const sibling = join(process.cwd(), '..', 'escape-probe.txt');
  await writeFile(sibling, 'escaped\n', 'utf8');
  results.writeSibling = true;
} catch {
  // blocked
}

try {
  await writeFile('/usr/local/ael-escape-probe.txt', 'escaped\n', 'utf8');
  results.writeRootFs = true;
} catch {
  // blocked (read-only root)
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
