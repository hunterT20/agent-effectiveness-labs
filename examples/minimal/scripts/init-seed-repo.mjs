#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const seedRepo = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed-repo');
const pinnedCommit = '8fc35dac5eef18ad0e4d61a8e3ad6c6ba814511c';

function runGit(args, env = {}) {
  const result = spawnSync('git', args, {
    cwd: seedRepo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
      ...env,
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

if (!existsSync(join(seedRepo, 'README.md'))) {
  throw new Error(`missing seed repo at ${seedRepo}`);
}

if (!existsSync(join(seedRepo, '.git'))) {
  runGit(['init']);
  runGit(['config', 'user.email', 'ael@example.com']);
  runGit(['config', 'user.name', 'AEL']);
  runGit(['add', '.']);
  runGit(['commit', '-m', 'seed']);
}

const commit = runGit(['rev-parse', 'HEAD']);
if (commit !== pinnedCommit) {
  throw new Error(`seed repo commit drift: expected ${pinnedCommit}, got ${commit}`);
}

process.stdout.write(`${commit}\n`);
