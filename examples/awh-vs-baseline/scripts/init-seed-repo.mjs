#!/usr/bin/env node
/**
 * Initialise the vendored awh-vs-baseline seed repository as a real git repository.
 *
 * Deterministic: fixed author/committer, fixed dates, no hooks, no signing,
 * `core.autocrlf=false`, `core.filemode=false`. Idempotent: an existing `.git`
 * whose HEAD matches the pinned commit is left untouched.
 *
 * Prints the seed commit hash on stdout.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const seedRepo = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed-repo');
const pinnedCommit = 'cb0d8014656e75ebd264db8ee0bcf0710b30bd10';

const FIXED_DATE = '2026-01-01T00:00:00Z';
const GIT_CONFIG = [
  '-c',
  'user.name=AEL',
  '-c',
  'user.email=ael@example.com',
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.filemode=false',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'init.defaultBranch=main',
  '-c',
  'core.hooksPath=.git/ael-no-hooks',
];

function runGit(args) {
  const env = { ...process.env, GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) {
    delete env[key];
  }
  const result = spawnSync('git', [...GIT_CONFIG, ...args], {
    cwd: seedRepo,
    encoding: 'utf8',
    env,
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function headCommit() {
  const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: seedRepo,
    encoding: 'utf8',
    shell: false,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(fn) {
  const lockDir = join(
    tmpdir(),
    `ael-seed-init-${createHash('sha256').update(seedRepo).digest('hex').slice(0, 16)}.lock`,
  );
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      if (Date.now() > deadline) {
        rmSync(lockDir, { recursive: true, force: true });
      } else {
        sleepMs(50);
      }
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function normalizeIndexModes() {
  const files = runGit(['ls-files'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const file of files) {
    runGit(['update-index', '--chmod=-x', '--', file]);
  }
}

function buildRepository() {
  rmSync(join(seedRepo, '.git'), { recursive: true, force: true });
  runGit(['init', '--quiet']);
  runGit(['add', '--all']);
  normalizeIndexModes();
  runGit(['commit', '--quiet', '--no-verify', '--message', 'awh seed']);
}

if (!existsSync(join(seedRepo, 'README.md'))) {
  throw new Error(`missing seed repo at ${seedRepo}`);
}

const commit = withLock(() => {
  const existing = existsSync(join(seedRepo, '.git')) ? headCommit() : null;
  if (existing === pinnedCommit) {
    return existing;
  }
  if (existing !== null) {
    process.stderr.write(`seed repo HEAD ${existing} is stale; rebuilding\n`);
  }
  buildRepository();
  return headCommit();
});

if (process.env.AEL_SEED_PRINT_ONLY !== '1' && commit !== pinnedCommit) {
  throw new Error(
    `seed repo commit drift: expected ${pinnedCommit}, got ${commit}. ` +
      'Update pinnedCommit here and repository.commit in the suite files.',
  );
}

process.stdout.write(`${commit}\n`);
