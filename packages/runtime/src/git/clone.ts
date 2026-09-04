import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve as resolvePath } from 'node:path';

import { GIT_ERROR_CODES, GitRepositoryError } from './errors.js';

export interface GitRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runGit(
  args: readonly string[],
  options: { cwd: string; env?: Readonly<Record<string, string>> },
): Promise<GitRunResult> {
  return new Promise((resolve) => {
    const child = spawn('git', [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('close', (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
    child.on('error', () => {
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: 'git spawn failed',
      });
    });
  });
}

/** Name of the empty hooks directory created inside the clone's `.git` directory. */
export const DISABLED_HOOKS_DIR_NAME = 'ael-hooks-disabled';

export interface CloneRepositoryInput {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly commit: string;
  /**
   * Empty directory used as `core.hooksPath` for the clone. Defaults to
   * `<targetPath>/.git/ael-hooks-disabled`, which is created if missing. Must be (or become) an
   * empty directory so no hook can ever run inside the workspace.
   */
  readonly hooksPath?: string;
}

/** Environment overriding `core.hooksPath` for a single git invocation (highest precedence). */
function hooksDisabledEnv(hooksPath: string): Readonly<Record<string, string>> {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hooksPath,
  };
}

/**
 * Argument vector for the seed clone. Exposed for tests.
 *
 * - `--no-local`: force the regular transport even for local paths so objects are packed and
 *   copied, never hardlinked or referenced from the source repository.
 * - `--no-hardlinks`: belt-and-braces for the same guarantee.
 * - `--template=<empty>`: do not seed `.git/hooks` (or anything else) from the user's template.
 * - `--no-recurse-submodules`: never fetch nested repositories (submodules are refused anyway).
 */
export function buildCloneArgs(input: {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly templateDir: string;
}): readonly string[] {
  return [
    'clone',
    '--no-local',
    '--no-hardlinks',
    '--no-recurse-submodules',
    `--template=${input.templateDir}`,
    '--',
    input.sourcePath,
    input.targetPath,
  ];
}

export interface RepositoryTreeInspection {
  readonly hasSubmodules: boolean;
  readonly hasLfs: boolean;
}

/**
 * Inspect the tree at `commit` in `repositoryPath` for features the v1 runtime refuses:
 * submodules (`.gitmodules` or gitlink entries) and Git LFS (`.gitattributes` with `filter=lfs`,
 * or a `.lfsconfig`).
 */
export async function inspectRepositoryTree(
  repositoryPath: string,
  commit: string,
): Promise<RepositoryTreeInspection> {
  const listing = await runGit(['ls-tree', '-r', '-z', '--full-tree', commit], {
    cwd: repositoryPath,
  });
  if (listing.exitCode !== 0) {
    throw new GitRepositoryError(
      GIT_ERROR_CODES.INSPECT_FAILED,
      `git ls-tree failed for ${commit}: ${listing.stderr.trim()}`,
    );
  }

  let hasSubmodules = false;
  let hasLfs = false;
  const attributeFiles: string[] = [];
  for (const entry of listing.stdout.split('\0')) {
    if (entry.length === 0) {
      continue;
    }
    // Format: "<mode> <type> <object>\t<path>"
    const tab = entry.indexOf('\t');
    if (tab === -1) {
      continue;
    }
    const [mode] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    if (mode === '160000' || path === '.gitmodules') {
      hasSubmodules = true;
    }
    if (path === '.lfsconfig') {
      hasLfs = true;
    }
    if (basename(path) === '.gitattributes') {
      attributeFiles.push(path);
    }
  }

  for (const path of attributeFiles) {
    if (hasLfs) {
      break;
    }
    const show = await runGit(['show', `${commit}:${path}`], { cwd: repositoryPath });
    if (show.exitCode === 0 && /filter\s*=\s*lfs\b/.test(show.stdout)) {
      hasLfs = true;
    }
  }

  return { hasSubmodules, hasLfs };
}

async function removeQuietly(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Clone `sourcePath` into `targetPath` and detach at `commit` with hooks permanently disabled.
 *
 * Refuses repositories using submodules or Git LFS (v1 limitation) before any clone happens.
 * After cloning, `core.hooksPath` is persisted in the clone's `.git/config` pointing at an empty
 * directory so every later git command in the workspace runs without hooks.
 */
export async function cloneDetachedRepository(input: CloneRepositoryInput): Promise<void> {
  const inspection = await inspectRepositoryTree(input.sourcePath, input.commit);
  if (inspection.hasSubmodules) {
    throw new GitRepositoryError(
      GIT_ERROR_CODES.SUBMODULES_UNSUPPORTED,
      `repository ${input.sourcePath} at ${input.commit} uses git submodules, which are not supported`,
    );
  }
  if (inspection.hasLfs) {
    throw new GitRepositoryError(
      GIT_ERROR_CODES.LFS_UNSUPPORTED,
      `repository ${input.sourcePath} at ${input.commit} uses Git LFS, which is not supported`,
    );
  }

  // Empty directory used both as the clone template and as the hooks path during the clone
  // itself (the clone's own .git directory does not exist yet).
  const scratchDir = await mkdtemp(join(tmpdir(), 'ael-git-empty-'));
  try {
    const clone = await runGit(
      buildCloneArgs({
        sourcePath: input.sourcePath,
        targetPath: input.targetPath,
        templateDir: scratchDir,
      }),
      { cwd: process.cwd(), env: hooksDisabledEnv(scratchDir) },
    );
    if (clone.exitCode !== 0) {
      throw new GitRepositoryError(
        GIT_ERROR_CODES.CLONE_FAILED,
        `git clone failed: ${clone.stderr.trim()}`,
      );
    }

    const hooksPath = resolvePath(
      input.hooksPath ?? join(input.targetPath, '.git', DISABLED_HOOKS_DIR_NAME),
    );
    await mkdir(hooksPath, { recursive: true });
    const config = await runGit(['config', '--local', 'core.hooksPath', hooksPath], {
      cwd: input.targetPath,
      env: hooksDisabledEnv(hooksPath),
    });
    if (config.exitCode !== 0) {
      throw new GitRepositoryError(
        GIT_ERROR_CODES.CONFIG_FAILED,
        `git config core.hooksPath failed: ${config.stderr.trim()}`,
      );
    }

    const checkout = await runGit(['checkout', '--detach', input.commit, '--'], {
      cwd: input.targetPath,
      env: hooksDisabledEnv(hooksPath),
    });
    if (checkout.exitCode !== 0) {
      throw new GitRepositoryError(
        GIT_ERROR_CODES.CHECKOUT_FAILED,
        `git checkout failed: ${checkout.stderr.trim()}`,
      );
    }
  } finally {
    await removeQuietly(scratchDir);
  }
}

export async function gitDiffBinary(workspaceRoot: string): Promise<string> {
  const result = await runGit(['diff', '--binary', 'HEAD'], { cwd: workspaceRoot });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`git diff failed: ${result.stderr}`);
  }
  return result.stdout;
}

export async function gitResetClean(workspaceRoot: string): Promise<void> {
  const reset = await runGit(['reset', '--hard', 'HEAD'], { cwd: workspaceRoot });
  if (reset.exitCode !== 0) {
    throw new Error(`git reset failed: ${reset.stderr}`);
  }
  const clean = await runGit(['clean', '-fdx'], { cwd: workspaceRoot });
  if (clean.exitCode !== 0) {
    throw new Error(`git clean failed: ${clean.stderr}`);
  }
}
