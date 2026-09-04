#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

function finish(pass, reason) {
  process.stdout.write(`${JSON.stringify({ pass, reason })}\n`);
  process.exit(pass ? 0 : 1);
}

const cases = [
  { args: ['c2f', '100'], expected: '212' },
  { args: ['c2f', '0'], expected: '32' },
  { args: ['f2c', '212'], expected: '100' },
  { args: ['f2c', '32'], expected: '0' },
];

const script = join(process.cwd(), 'src', 'temperature.mjs');
for (const testCase of cases) {
  const result = spawnSync(process.execPath, [script, ...testCase.args], {
    encoding: 'utf8',
    timeout: 5_000,
    shell: false,
  });
  if (result.status !== 0) {
    finish(
      false,
      `node src/temperature.mjs ${testCase.args.join(' ')} exited ${String(result.status)}`,
    );
  }
  const actual = result.stdout.trim();
  if (actual !== testCase.expected) {
    finish(
      false,
      `node src/temperature.mjs ${testCase.args.join(' ')} => ${actual}, expected ${testCase.expected}`,
    );
  }
}

finish(true, 'temperature cases passed');
