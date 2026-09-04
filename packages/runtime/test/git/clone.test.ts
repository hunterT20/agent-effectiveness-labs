import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import {
  DISABLED_HOOKS_DIR_NAME,
  buildCloneArgs,
  cloneDetachedRepository,
  inspectRepositoryTree,
  runGit,
} from '../../src/git/clone.js';
import { GIT_ERROR_CODES, GitRepositoryError } from '../../src/git/errors.js';

const isWindows = process.platform === 'win32';
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Deterministic, hermetic git environment for fixture repositories. */
const fixtureGitEnv: Record<string, string> = {
  GIT_AUTHOR_NAME: 'AEL Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@ael.invalid',
  GIT_COMMITTER_NAME: 'AEL Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@ael.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, args: readonly string[], extraEnv: Record<string, string> = {}): string {
  const result = spawnSync('git', [...args], {
    cwd,
    env: { ...process.env, ...fixtureGitEnv, ...extraEnv },
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

interface FixtureRepo {
  readonly path: string;
  readonly commit: string;
}

function createFixtureRepo(
  files: Record<string, string> = { 'README.md': 'seed\n', 'src/answer.txt': 'placeholder\n' },
): FixtureRepo {
  const path = tempDir('ael-git-src-');
  git(path, ['init', '-q', '-b', 'main']);
  git(path, ['config', 'commit.gpgsign', 'false']);
  for (const [relativePath, content] of Object.entries(files)) {
    const full = join(path, relativePath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  git(path, ['add', '-A']);
  git(path, ['commit', '-q', '-m', 'seed']);
  const commit = git(path, ['rev-parse', 'HEAD']);
  return { path, commit };
}

async function captureGitError(promise: Promise<unknown>): Promise<GitRepositoryError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof GitRepositoryError)) {
    throw new Error(`expected GitRepositoryError, got ${String(error)}`);
  }
  return error;
}

function writeFailingHook(hooksDir: string, name: string, markerPath: string): void {
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, name);
  writeFileSync(hookPath, `#!/bin/sh\necho ran > "${markerPath}"\nexit 1\n`, 'utf8');
  chmodSync(hookPath, 0o755);
}

describe('buildCloneArgs', () => {
  it('uses --no-local, --no-hardlinks and an empty template', () => {
    const args = buildCloneArgs({ sourcePath: '/src', targetPath: '/dst', templateDir: '/empty' });
    expect(args[0]).toBe('clone');
    expect(args).toContain('--no-local');
    expect(args).toContain('--no-hardlinks');
    expect(args).toContain('--no-recurse-submodules');
    expect(args).toContain('--template=/empty');
    expect(args.slice(-3)).toEqual(['--', '/src', '/dst']);
  });
});

describe('cloneDetachedRepository', () => {
  it('clones detached at the requested commit', async () => {
    const source = createFixtureRepo();
    const target = tempDir('ael-git-dst-');

    await cloneDetachedRepository({
      sourcePath: source.path,
      targetPath: target,
      commit: source.commit,
    });

    expect(git(target, ['rev-parse', 'HEAD'])).toBe(source.commit);
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('seed\n');
    const branch = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: target, shell: false });
    expect(branch.status).not.toBe(0); // detached HEAD
  });

  it('does not share object files with the source (--no-local / --no-hardlinks)', async () => {
    const source = createFixtureRepo();
    const target = tempDir('ael-git-dst-');
    await cloneDetachedRepository({
      sourcePath: source.path,
      targetPath: target,
      commit: source.commit,
    });

    // With --no-local objects travel through the transport and land as a pack, never as
    // hardlinked loose objects.
    const packDir = join(target, '.git', 'objects', 'pack');
    expect(existsSync(packDir)).toBe(true);
    expect(readdirSync(packDir).some((name) => name.endsWith('.pack'))).toBe(true);

    const sourceObjects = join(source.path, '.git', 'objects');
    for (const shard of readdirSync(sourceObjects)) {
      if (shard.length !== 2) {
        continue;
      }
      for (const name of readdirSync(join(sourceObjects, shard))) {
        expect(statSync(join(sourceObjects, shard, name)).nlink).toBe(1);
      }
    }
  });

  it.skipIf(isWindows)('disables hooks for the clone and every later git command', async () => {
    const source = createFixtureRepo();
    const sourceMarker = join(tempDir('ael-git-marker-'), 'source-hook-ran');
    writeFailingHook(join(source.path, '.git', 'hooks'), 'pre-commit', sourceMarker);

    // A user-level template with hooks must not leak into the clone either.
    const template = tempDir('ael-git-template-');
    const templateMarker = join(template, 'post-checkout-ran');
    writeFailingHook(join(template, 'hooks'), 'post-checkout', templateMarker);
    vi.stubEnv('GIT_TEMPLATE_DIR', template);

    const target = tempDir('ael-git-dst-');
    await cloneDetachedRepository({
      sourcePath: source.path,
      targetPath: target,
      commit: source.commit,
    });

    expect(existsSync(templateMarker)).toBe(false);
    expect(existsSync(join(target, '.git', 'hooks', 'post-checkout'))).toBe(false);

    const hooksPath = git(target, ['config', '--local', 'core.hooksPath']);
    expect(hooksPath).toBe(join(target, '.git', DISABLED_HOOKS_DIR_NAME));
    expect(statSync(hooksPath).isDirectory()).toBe(true);
    expect(readdirSync(hooksPath)).toEqual([]);

    // Even a hook dropped into the clone's own .git/hooks must never run.
    const cloneMarker = join(tempDir('ael-git-marker-'), 'clone-hook-ran');
    writeFailingHook(join(target, '.git', 'hooks'), 'pre-commit', cloneMarker);
    vi.unstubAllEnvs();
    writeFileSync(join(target, 'src', 'answer.txt'), 'changed\n', 'utf8');
    const commit = await runGit(['commit', '-q', '-a', '-m', 'agent change'], {
      cwd: target,
      env: fixtureGitEnv,
    });
    expect(commit.exitCode).toBe(0);
    expect(existsSync(cloneMarker)).toBe(false);
    expect(existsSync(sourceMarker)).toBe(false);
  });

  it('honours an explicit hooksPath', async () => {
    const source = createFixtureRepo();
    const target = tempDir('ael-git-dst-');
    const hooksPath = join(tempDir('ael-git-hooks-'), 'empty-hooks');
    await cloneDetachedRepository({
      sourcePath: source.path,
      targetPath: target,
      commit: source.commit,
      hooksPath,
    });
    expect(git(target, ['config', '--local', 'core.hooksPath'])).toBe(hooksPath);
    expect(readdirSync(hooksPath)).toEqual([]);
  });

  it('refuses repositories with submodules', async () => {
    const source = createFixtureRepo({
      'README.md': 'seed\n',
      '.gitmodules': '[submodule "lib"]\n\tpath = lib\n\turl = https://example.invalid/lib.git\n',
    });
    const target = tempDir('ael-git-dst-');

    const error = await captureGitError(
      cloneDetachedRepository({
        sourcePath: source.path,
        targetPath: target,
        commit: source.commit,
      }),
    );

    expect(error.code).toBe(GIT_ERROR_CODES.SUBMODULES_UNSUPPORTED);
    expect(error.message).toMatch(/submodules/);
    expect(existsSync(join(target, '.git'))).toBe(false);
  });

  it('refuses repositories with gitlink entries even without .gitmodules', async () => {
    const source = createFixtureRepo();
    // Fake a gitlink (mode 160000) in the index and commit it.
    git(source.path, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${source.commit},vendor/lib`,
    ]);
    git(source.path, ['commit', '-q', '-m', 'add gitlink']);
    const commit = git(source.path, ['rev-parse', 'HEAD']);

    const inspection = await inspectRepositoryTree(source.path, commit);
    expect(inspection.hasSubmodules).toBe(true);
  });

  it('refuses repositories with LFS attributes', async () => {
    const source = createFixtureRepo({
      'README.md': 'seed\n',
      'assets/.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n',
    });
    const target = tempDir('ael-git-dst-');

    const error = await captureGitError(
      cloneDetachedRepository({
        sourcePath: source.path,
        targetPath: target,
        commit: source.commit,
      }),
    );

    expect(error.code).toBe(GIT_ERROR_CODES.LFS_UNSUPPORTED);
    expect(error.message).toMatch(/LFS/);
  });

  it('accepts .gitattributes without LFS filters', async () => {
    const source = createFixtureRepo({
      'README.md': 'seed\n',
      '.gitattributes': '* text=auto\n*.png binary\n',
    });
    const inspection = await inspectRepositoryTree(source.path, source.commit);
    expect(inspection).toEqual({ hasSubmodules: false, hasLfs: false });
  });

  it('reports a typed error for an unknown commit', async () => {
    const source = createFixtureRepo();
    const target = tempDir('ael-git-dst-');
    const error = await captureGitError(
      cloneDetachedRepository({
        sourcePath: source.path,
        targetPath: target,
        commit: '0000000000000000000000000000000000000000',
      }),
    );
    expect(error.code).toBe(GIT_ERROR_CODES.INSPECT_FAILED);
  });
});
