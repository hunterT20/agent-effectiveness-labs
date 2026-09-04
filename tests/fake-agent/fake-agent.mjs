#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function parseArgs(argv) {
  const options = { workspace: process.cwd(), prompt: null, phase: 'initial', session: 'new' };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (
      token === '--workspace' ||
      token === '--prompt' ||
      token === '--phase' ||
      token === '--session' ||
      token === '--plugin-dir' ||
      token === '--resume' ||
      token === '--hint'
    ) {
      const value = argv[index + 1];
      if (token === '--workspace' && value !== undefined) {
        options.workspace = value;
      } else if (token === '--prompt' && value !== undefined) {
        options.prompt = value;
      } else if (token === '--phase' && value !== undefined) {
        options.phase = value;
      } else if (token === '--session' && value !== undefined) {
        options.session = value;
      }
      index += 1;
    }
  }
  return options;
}

function modeFromPrompt(promptText) {
  const match = /<!--\s*ael-fake-mode:\s*([a-z0-9-]+)\s*-->/i.exec(promptText);
  return match?.[1] ?? null;
}

const options = parseArgs(process.argv.slice(2));
const targetFile = join(options.workspace, 'src', 'answer.txt');

function writeSuccess() {
  mkdirSync(dirname(targetFile), { recursive: true });
  writeFileSync(targetFile, 'correct-answer\n', 'utf8');
}

function resolveMode() {
  let promptText = '';
  if (options.prompt !== null) {
    promptText = readFileSync(options.prompt, 'utf8');
  }
  return modeFromPrompt(promptText) ?? process.env.AEL_FAKE_MODE ?? 'success';
}

async function main() {
  if (process.env.AEL_ARM_MARKER !== undefined) {
    console.log(`AEL_ARM_MARKER=${process.env.AEL_ARM_MARKER}`);
  }

  const mode = resolveMode();
  console.log(`AEL_FAKE_RESOLVED_MODE=${mode}`);

  switch (mode) {
    case 'success':
      writeSuccess();
      process.exit(0);
      break;
    case 'incorrect':
      mkdirSync(dirname(targetFile), { recursive: true });
      writeFileSync(targetFile, 'wrong-answer\n', 'utf8');
      process.exit(0);
      break;
    case 'timeout':
      await new Promise(() => {
        setInterval(() => undefined, 60_000);
      });
      break;
    case 'child-survivor':
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], {
        detached: true,
        stdio: 'ignore',
        shell: false,
      }).unref();
      writeSuccess();
      process.exit(0);
      break;
    case 'claims-done':
      console.log('AEL_TELEMETRY: {"completed":true}');
      mkdirSync(dirname(targetFile), { recursive: true });
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
      writeFileSync(join(options.workspace, 'blob.bin'), Buffer.from([0, 1, 2, 255]));
      process.exit(0);
      break;
    case 'overlay-tamper':
      writeSuccess();
      writeFileSync(join(options.workspace, 'overlay-marker.txt'), 'tampered\n', 'utf8');
      process.exit(0);
      break;
    case 'scope-escape': {
      const escapeRoot = process.env.AEL_FAKE_ESCAPE_DIR ?? dirname(options.workspace);
      mkdirSync(escapeRoot, { recursive: true });
      writeFileSync(join(escapeRoot, 'ael-scope-escape.txt'), 'escaped\n', 'utf8');
      process.exit(0);
      break;
    }
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
      writeSuccess();
      process.exit(0);
  }
}

void main();
