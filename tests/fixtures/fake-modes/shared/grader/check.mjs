#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function fail(message) {
  console.log(JSON.stringify({ pass: false, message }));
  process.exit(1);
}

function ok(message) {
  console.log(JSON.stringify({ pass: true, message }));
  process.exit(0);
}

const answerPath = join(process.cwd(), 'src', 'answer.txt');
if (!existsSync(answerPath)) {
  fail('missing answer');
}
const answer = readFileSync(answerPath, 'utf8').trim();
if (answer !== 'correct-answer') {
  fail('incorrect answer');
}

const blob = join(process.cwd(), 'blob.bin');
if (existsSync(blob)) {
  const bytes = readFileSync(blob);
  if (!Buffer.from([0, 1, 2, 255]).equals(bytes)) {
    fail('binary mismatch');
  }
}

const notes = join(process.cwd(), 'notes.txt');
if (existsSync(notes) && readFileSync(notes, 'utf8').trim() !== 'extra') {
  fail('notes mismatch');
}

ok('ok');
