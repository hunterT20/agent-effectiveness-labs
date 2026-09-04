#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

function finish(pass, reason) {
  process.stdout.write(`${JSON.stringify({ pass, reason })}\n`);
  process.exit(pass ? 0 : 1);
}

const cases = [
  { args: ['200', '25'], expected: '150' },
  { args: ['80', '0'], expected: '80' },
  { args: ['100', '10'], expected: '90' },
];

const script = join(process.cwd(), 'src', 'discount.mjs');
for (const testCase of cases) {
  const result = spawnSync(process.execPath, [script, ...testCase.args], {
    encoding: 'utf8',
    timeout: 5_000,
    shell: false,
  });
  if (result.status !== 0) {
    finish(false, `node src/discount.mjs ${testCase.args.join(' ')} exited ${String(result.status)}`);
  }
  const actual = result.stdout.trim();
  if (actual !== testCase.expected) {
    finish(
      false,
      `node src/discount.mjs ${testCase.args.join(' ')} => ${actual}, expected ${testCase.expected}`,
    );
  }
}

finish(true, 'discount cases passed');
