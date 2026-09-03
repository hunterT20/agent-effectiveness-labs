#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const mode = process.env.AEL_FAKE_MODE ?? 'success';

function parseArgs(argv) {
  const options = { workspace: process.cwd(), prompt: null, phase: 'initial', session: 'new' };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--workspace') {
      options.workspace = argv[index + 1] ?? options.workspace;
      index += 1;
    } else if (token === '--prompt') {
      options.prompt = argv[index + 1] ?? null;
      index += 1;
    } else if (token === '--phase') {
      options.phase = argv[index + 1] ?? options.phase;
      index += 1;
    } else if (token === '--session') {
      options.session = argv[index + 1] ?? options.session;
      index += 1;
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const targetFile = join(options.workspace, 'src', 'answer.txt');

function writeSuccess() {
  mkdirSync(dirname(targetFile), { recursive: true });
  writeFileSync(targetFile, 'correct-answer\n', 'utf8');
}

async function main() {
  switch (mode) {
    case 'success':
      writeSuccess();
      process.exit(0);
      break;
    case 'incorrect':
      writeFileSync(targetFile, 'wrong-answer\n', 'utf8');
      process.exit(0);
      break;
    case 'timeout':
      await new Promise(() => undefined);
      break;
    case 'child-survivor':
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
        shell: false,
      }).unref();
      writeSuccess();
      process.exit(0);
      break;
    case 'claims-done':
      console.log('AEL_TELEMETRY: {"completed":true}');
      writeFileSync(targetFile, 'wrong-answer\n', 'utf8');
      process.exit(0);
      break;
    case 'nonzero-correct':
      writeSuccess();
      process.exit(1);
      break;
    case 'untracked':
      writeSuccess();
      writeFileSync(join(options.workspace, 'notes.txt'), 'extra\n', 'utf8');
      process.exit(0);
      break;
    case 'binary':
      writeSuccess();
      writeFileSync(join(options.workspace, 'blob.bin'), Buffer.from([0, 1, 2, 255]), 'utf8');
      process.exit(0);
      break;
    case 'overlay-tamper':
      writeSuccess();
      writeFileSync(join(options.workspace, 'overlay-marker.txt'), 'tampered\n', 'utf8');
      process.exit(0);
      break;
    case 'scope-escape':
      writeFileSync('/tmp/ael-scope-escape.txt', 'escaped\n', 'utf8');
      process.exit(0);
      break;
    case 'secret-leak':
      console.log('api_key=super-secret-token');
      writeSuccess();
      process.exit(0);
      break;
    case 'malformed-telemetry':
      console.log('AEL_TELEMETRY: not-json');
      writeSuccess();
      process.exit(0);
      break;
    default:
      if (options.prompt !== null) {
        readFileSync(options.prompt, 'utf8');
      }
      writeSuccess();
      process.exit(0);
  }
}

void main();
