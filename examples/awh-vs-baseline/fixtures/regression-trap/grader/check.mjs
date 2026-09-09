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
  const { toPercent, fromPercent } = await load('src/units.mjs');
  if (toPercent(0.25) !== 25 || toPercent(1) !== 100) {
    finish(false, 'toPercent regression');
  }
  if (fromPercent(25) !== 0.25 || fromPercent(50) !== 0.5) {
    finish(false, 'fromPercent incorrect');
  }
  finish(true, 'passed');
} catch (error) {
  finish(false, error instanceof Error ? error.message : String(error));
}
