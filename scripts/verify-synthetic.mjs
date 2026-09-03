#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = mkdtempSync(join(tmpdir(), 'ael-synthetic-perf-'));
const started = Date.now();

const run = spawnSync(
  'node',
  [
    'packages/cli/dist/index.js',
    'run',
    '--suite',
    'examples/minimal/suite.yaml',
    '--output',
    outputRoot,
    '--fake-agent',
    join(repoRoot, 'tests/fake-agent/fake-agent.mjs'),
  ],
  { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, AEL_SKIP_SANDBOX_PROBE: '1' } },
);

const elapsedMs = Date.now() - started;
const thresholdMs = 5 * 60 * 1000;

if (run.status !== 0) {
  console.error(run.stderr || run.stdout);
  process.exit(1);
}

if (elapsedMs > thresholdMs) {
  console.error(`synthetic perf smoke exceeded 5 minutes: ${String(elapsedMs)}ms`);
  process.exit(1);
}

console.log(`synthetic perf smoke ok in ${String(elapsedMs)}ms`);
