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
  const payroll = read('src/payroll.mjs');
  if (payroll.includes('(grossCents * percent) / 100') || payroll.includes('grossCents * percent / 100')) {
    finish(false, 'payroll.mjs was modified; review-only fixture');
  }
  const notes = read('reviews/PAYROLL.md');
  if (!notes.includes('withholdingCents') || !notes.includes('100')) {
    finish(false, 'review must cite withholdingCents and the missing divide-by-100');
  }
  if (/no defects/i.test(notes) && !notes.includes('withholdingCents')) {
    finish(false, 'review claimed no defects');
  }
  finish(true, 'passed');
} catch (error) {
  finish(false, error instanceof Error ? error.message : String(error));
}
