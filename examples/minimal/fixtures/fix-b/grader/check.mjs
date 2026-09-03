#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const answerPath = join(process.cwd(), 'src', 'answer.txt');
if (!existsSync(answerPath)) {
  console.error('missing answer');
  process.exit(1);
}
const answer = readFileSync(answerPath, 'utf8').trim();
if (answer !== 'correct-answer') {
  console.error('incorrect answer');
  process.exit(1);
}
process.exit(0);
