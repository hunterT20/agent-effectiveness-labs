#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function finish(pass, reason) {
  process.stdout.write(JSON.stringify({ pass, reason }) + '\n');
  process.exit(pass ? 0 : 1);
}

function read(rel) {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

function exists(rel) {
  return existsSync(join(process.cwd(), rel));
}

async function load(rel) {
  return import(pathToFileURL(join(process.cwd(), rel)).href);
}

function git(args) {
  return spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8', shell: false });
}

try {
  const { INSUFFICIENT_FUNDS } = await load('src/messages.mjs');
  if (INSUFFICIENT_FUNDS !== 'Insufficient funds') {
    finish(false, 'typo not fixed');
  }
  const changed = git(['diff', '--name-only', 'HEAD']);
  const names = changed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const allowed = new Set(['src/messages.mjs']);
  for (const name of names) {
    if (!allowed.has(name)) {
      finish(false, 'out-of-scope change: ' + name);
    }
  }
  finish(true, 'passed');
} catch (error) {
  finish(false, error instanceof Error ? error.message : String(error));
}
