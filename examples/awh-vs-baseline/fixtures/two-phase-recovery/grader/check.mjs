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
  const { Journal } = await load('src/journal.mjs');
  const journal = new Journal();
  const a = journal.add(100);
  const b = journal.add(50);
  journal.void(a);
  const items = journal.items();
  if (items.length !== 2) {
    finish(false, 'void must be a soft delete; items() length ' + String(items.length));
  }
  const voided = items.find((item) => item.id === a);
  if (voided === undefined || voided.voided !== true) {
    finish(false, 'voided item missing voided:true');
  }
  if (journal.totalCents() !== 50) {
    finish(false, 'totalCents should exclude voided entries');
  }
  try {
    journal.void(b + 99);
    finish(false, 'void(unknown) must throw');
  } catch (error) {
    if (!(error instanceof RangeError)) {
      finish(false, 'void(unknown) must throw RangeError');
    }
  }
  finish(true, 'passed');
} catch (error) {
  finish(false, error instanceof Error ? error.message : String(error));
}
