#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const seedRepo = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed-repo');
const pinnedCommit = '70955d281eaf0cad19cddcc5cfaf1bb2397ed2ee';

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: seedRepo,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' },
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

if (!existsSync(join(seedRepo, '.git'))) {
  runGit(['init']);
  runGit(['config', 'user.email', 'ael@example.com']);
  runGit(['config', 'user.name', 'AEL']);
  runGit(['add', '.']);
  runGit(['commit', '-m', 'awh seed']);
}
const actual = runGit(['rev-parse', 'HEAD']);
if (actual !== pinnedCommit) throw new Error(`seed drift: expected ${pinnedCommit}, got ${actual}`);
process.stdout.write(`${actual}\n`);
