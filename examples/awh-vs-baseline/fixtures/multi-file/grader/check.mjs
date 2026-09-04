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
  const { Ledger } = await load('src/ledger.mjs');
  const { summarize } = await load('src/report.mjs');
  const ledger = new Ledger();
  ledger.add(100, 'food');
  ledger.add(250, 'rent');
  ledger.add(50);
  const entries = ledger.entries();
  if (entries[0].category !== 'food' || entries[2].category !== 'general') {
    finish(false, 'Ledger.add must persist category (default general)');
  }
  const summary = summarize(entries);
  if (summary.total !== 400 || summary.byCategory.food !== 100 || summary.byCategory.general !== 50) {
    finish(false, 'summarize.byCategory mismatch');
  }
  finish(true, 'passed');
} catch (error) {
  finish(false, error instanceof Error ? error.message : String(error));
}
