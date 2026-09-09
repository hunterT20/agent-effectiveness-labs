#!/usr/bin/env node
/**
 * Initialise the vendored seed repository as a real git repository.
 *
 * The seed working tree (`../seed-repo`) is committed to this monorepo as regular files; the
 * `.git` directory is derived and ignored. This script creates it deterministically so the commit
 * hash is identical on every machine (fixed author/committer, fixed dates, no hooks, no signing,
 * `core.autocrlf=false`, `core.filemode=false`).
 *
 * History is two commits: the original M1 placeholder tree (`8fc35dac…`, still checked out by
 * existing unit tests) and a second `shop-utils seed` commit that is HEAD / `repository.commit`.
 *
 * It is idempotent: an existing `.git` whose HEAD matches the pinned commit is left untouched, a
 * stale one is rebuilt.
 *
 * Prints the seed commit hash on stdout.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const seedRepo = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed-repo');
const pinnedCommit = '189e0c17b0b2c45b93c4c4a7b36a9baa007ef5cc';
const LEGACY_COMMIT = '8fc35dac5eef18ad0e4d61a8e3ad6c6ba814511c';
const LEGACY_FILES = {
  '.gitignore': '.git\n',
  'README.md': 'seed\n',
  'src/answer.txt': 'pending\n',
};

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

function gitEnv() {
  const env = { ...process.env, GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) {
    delete env[key];
  }
  return env;
}

function runGit(args, extraConfig = GIT_CONFIG) {
  const result = spawnSync('git', [...extraConfig, ...args], {
    cwd: seedRepo,
    encoding: 'utf8',
    env: gitEnv(),
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** Normalize text files to LF so Windows checkouts produce the same commit hash as macOS/Linux. */
function normalizeFileContents(relativePath, contents) {
  if (relativePath.endsWith('.png') || relativePath.endsWith('.jpg') || relativePath.endsWith('.jpeg')) {
    return contents;
  }
  const text = contents.toString('utf8');
  if (text.includes('\0')) {
    return contents;
  }
  return Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8');
}

function collectWorkingTree() {
  /** @type {Record<string, Buffer>} */
  const files = {};
  const visit = (current) => {
    for (const name of readdirSync(current)) {
      if (name === '.git') {
        continue;
      }
      const fullPath = join(current, name);
      if (statSync(fullPath).isDirectory()) {
        visit(fullPath);
      } else {
        const relativePath = relative(seedRepo, fullPath);
        files[relativePath] = normalizeFileContents(relativePath, readFileSync(fullPath));
      }
    }
  };
  visit(seedRepo);
  return files;
}

function writeWorkingTree(files) {
  for (const name of readdirSync(seedRepo)) {
    if (name === '.git') {
      continue;
    }
    rmSync(join(seedRepo, name), { recursive: true, force: true });
  }
  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = join(seedRepo, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, normalizeFileContents(relativePath, contents));
  }
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

/** Cross-process mutex so parallel test workers do not race on the same seed repository. */
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
  const current = collectWorkingTree();
  rmSync(join(seedRepo, '.git'), { recursive: true, force: true });
  runGit(['init'], []);
  runGit(['config', 'user.email', 'ael@example.com'], []);
  runGit(['config', 'user.name', 'AEL'], []);
  writeWorkingTree(LEGACY_FILES);
  runGit(['add', '.'], []);
  runGit(['commit', '-m', 'seed'], []);
  const legacy = headCommit();
  if (legacy !== LEGACY_COMMIT) {
    throw new Error(`failed to recreate legacy seed commit: expected ${LEGACY_COMMIT}, got ${legacy}`);
  }
  writeWorkingTree(current);
  runGit(['add', '--all']);
  normalizeIndexModes();
  runGit(['commit', '--quiet', '--no-verify', '--message', 'shop-utils seed']);
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
