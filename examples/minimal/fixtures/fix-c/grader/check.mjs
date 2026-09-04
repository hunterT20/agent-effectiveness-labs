#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function finish(pass, reason) {
  process.stdout.write(`${JSON.stringify({ pass, reason })}\n`);
  process.exit(pass ? 0 : 1);
}

const validatePath = join(process.cwd(), 'src', 'validate.mjs');
const testPath = join(process.cwd(), 'tests', 'validate.test.mjs');

const mod = await import(pathToFileURL(validatePath).href);
if (typeof mod.isValidEmail !== 'function') {
  finish(false, 'isValidEmail export missing');
}

if (mod.isValidEmail('user@example.com') !== true) {
  finish(false, 'user@example.com should be valid');
}
if (mod.isValidEmail('user@example') !== false) {
  finish(false, 'user@example should be invalid');
}

const testSource = readFileSync(testPath, 'utf8');
if (!testSource.includes("isValidEmail('user@example')")) {
  finish(false, 'tests/validate.test.mjs must assert isValidEmail(\'user@example\')');
}
if (testSource.includes('TODO: add a regression test')) {
  finish(false, 'TODO regression test was not replaced');
}

const testRun = spawnSync(process.execPath, ['--test', testPath], {
  encoding: 'utf8',
  timeout: 10_000,
  shell: false,
});
if (testRun.status !== 0) {
  finish(false, `node --test tests/validate.test.mjs failed: ${testRun.stderr.trim()}`);
}

finish(true, 'email validation and regression test passed');
