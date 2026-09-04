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
  if (exists('src/legacy.mjs')) {
    finish(false, 'src/legacy.mjs still present');
  }
  const index = read('src/index.mjs');
  if (index.includes('legacy')) {
    finish(false, 'index still mentions legacy');
  }
  const mod = await load('src/index.mjs');
  if (typeof mod.formatCents !== 'function' || typeof mod.Ledger !== 'function') {
    finish(false, 'index lost required exports');
  }
  finish(true, 'passed');
} catch (error) {
  finish(false, error instanceof Error ? error.message : String(error));
}
