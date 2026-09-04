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
  const { monthlyRate, projectBalance } = await load('src/interest.mjs');
  if (monthlyRate(12) !== 0.01) {
    finish(false, 'monthlyRate(12) must be 0.01');
  }
  let expected = 10000;
  const rate = 0.01;
  for (let i = 0; i < 2; i += 1) {
    expected = Math.round(expected * (1 + rate));
  }
  if (projectBalance(10000, 12, 2) !== expected) {
    finish(false, 'projectBalance mismatch');
  }
  if (!read('docs/CHANGELOG.md').includes('1.3.1')) {
    finish(false, 'changelog missing 1.3.1');
  }
  finish(true, 'passed');
} catch (error) {
  finish(false, error instanceof Error ? error.message : String(error));
}
