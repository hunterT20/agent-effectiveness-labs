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
  const { computeTaxCents } = await load('src/tax.mjs');
  const cases = [
    [1999, 8.25, 165],
    [1001, 5, 50],
    [99, 10, 10],
  ];
  for (const [amount, rate, expected] of cases) {
    const actual = computeTaxCents(amount, rate);
    if (actual !== expected) {
      finish(false, 'computeTaxCents(' + amount + ', ' + rate + ') => ' + actual);
    }
  }
  finish(true, 'passed');
} catch (error) {
  finish(false, error instanceof Error ? error.message : String(error));
}
