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
  const { formatCents } = await load('src/money.mjs');
  const cases = [
    [1205, '$12.05'],
    [7, '$0.07'],
    [0, '$0.00'],
    [-1205, '-$12.05'],
  ];
  for (const [cents, expected] of cases) {
    const actual = formatCents(cents);
    if (actual !== expected) {
      finish(false, 'formatCents(' + cents + ') => ' + actual + ' expected ' + expected);
    }
  }
  finish(true, 'passed');
} catch (error) {
  finish(false, error instanceof Error ? error.message : String(error));
}
