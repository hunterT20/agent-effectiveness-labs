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
  if (!exists('artifacts/final-report.json')) {
    finish(false, 'missing artifacts/final-report.json');
  }
  const report = JSON.parse(read('artifacts/final-report.json'));
  const rows = JSON.parse(read('data/transactions.json'));
  const total = rows.reduce((sum, row) => sum + row.cents, 0);
  const byCategory = {};
  for (const row of rows) {
    byCategory[row.category] = (byCategory[row.category] ?? 0) + row.cents;
  }
  const largest = rows.reduce((best, row) => (row.cents > best.cents ? row : best));
  if (report.totalCents !== total || report.count !== rows.length) {
    finish(false, 'totals mismatch');
  }
  if (JSON.stringify(report.byCategory) !== JSON.stringify(byCategory)) {
    finish(false, 'byCategory mismatch');
  }
  if (report.largestId !== largest.id) {
    finish(false, 'largestId mismatch');
  }
  finish(true, 'passed');
} catch (error) {
  finish(false, error instanceof Error ? error.message : String(error));
}
