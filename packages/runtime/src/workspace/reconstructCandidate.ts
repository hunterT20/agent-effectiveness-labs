import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { z } from 'zod';

import { isInside } from '@ael/core';

import { runGit, cloneDetachedRepository } from '../git/clone.js';
import { computeTreeFingerprint } from '../git/fingerprint.js';

export interface UntrackedFileEntry {
  readonly path: string;
  readonly mode: number;
  readonly content: Buffer;
  readonly isSymlink: boolean;
  readonly linkTarget: string | null;
}

export interface UntrackedManifest {
  readonly schemaVersion: 1;
  readonly files: readonly UntrackedFileEntry[];
}

/** Public (plaintext-safe) view of the untracked manifest: no file contents. */
export const PublicUntrackedManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    files: z.array(
      z
        .object({
          path: z.string().min(1),
          mode: z.number().int().nonnegative(),
          sizeBytes: z.number().int().nonnegative(),
          sha256: z.string().length(64),
          isSymlink: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export type PublicUntrackedManifest = z.infer<typeof PublicUntrackedManifestSchema>;

const UntrackedArchiveSchema = z
  .object({
    schemaVersion: z.literal(1),
    files: z.array(
      z
        .object({
          path: z.string().min(1),
          mode: z.number().int().nonnegative(),
          contentBase64: z.string(),
          isSymlink: z.boolean(),
          linkTarget: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export interface CaptureUntrackedResult {
  readonly manifest: UntrackedManifest;
  readonly publicManifest: PublicUntrackedManifest;
  /** gzip(JSON) archive bytes that round-trip through {@link parseUntrackedArchive}. */
  readonly archiveBytes: Buffer;
  /** Plaintext archive path, or `null` when persistence was disabled (protected mode). */
  readonly archivePath: string | null;
  readonly invalidReason: string | null;
}

export interface CaptureUntrackedOptions {
  /** Workspace-relative paths (files or directory prefixes) to leave out of the candidate. */
  readonly excludePaths?: readonly string[];
  /** When `false`, the plaintext archive is not written to `artifactDir`. Defaults to `true`. */
  readonly persistArchive?: boolean;
}

function toPosix(path: string): string {
  return path.split('\\').join('/');
}

function isExcluded(filePath: string, excludePaths: readonly string[]): boolean {
  const posixPath = toPosix(filePath);
  return excludePaths.some((excluded) => {
    const normalized = toPosix(excluded).replace(/\/+$/, '');
    return posixPath === normalized || posixPath.startsWith(`${normalized}/`);
  });
}

async function listUntrackedFiles(workspaceRoot: string): Promise<string[]> {
  const result = await runGit(['ls-files', '--others', '--exclude-standard'], {
    cwd: workspaceRoot,
  });
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function toPublicUntrackedManifest(manifest: UntrackedManifest): PublicUntrackedManifest {
  return {
    schemaVersion: 1,
    files: manifest.files.map((file) => ({
      path: file.path,
      mode: file.mode,
      sizeBytes: file.content.length,
      sha256: createHash('sha256').update(file.content).digest('hex'),
      isSymlink: file.isSymlink,
    })),
  };
}

function serializeArchivePayload(manifest: UntrackedManifest): string {
  const payload: z.infer<typeof UntrackedArchiveSchema> = {
    schemaVersion: 1,
    files: manifest.files.map((file) => ({
      path: file.path,
      mode: file.mode,
      contentBase64: file.content.toString('base64'),
      isSymlink: file.isSymlink,
      linkTarget: file.linkTarget,
    })),
  };
  return JSON.stringify(payload);
}

export function serializeUntrackedArchive(manifest: UntrackedManifest): Buffer {
  return gzipSync(Buffer.from(serializeArchivePayload(manifest), 'utf8'));
}

export function parseUntrackedArchive(archiveBytes: Buffer): UntrackedManifest {
  const raw: unknown = JSON.parse(gunzipSync(archiveBytes).toString('utf8'));
  const parsed = UntrackedArchiveSchema.parse(raw);
  return {
    schemaVersion: 1,
    files: parsed.files.map((file) => ({
      path: file.path,
      mode: file.mode,
      content: Buffer.from(file.contentBase64, 'base64'),
      isSymlink: file.isSymlink,
      linkTarget: file.linkTarget,
    })),
  };
}

export async function captureUntrackedFiles(
  workspaceRoot: string,
  artifactDir: string,
  options: CaptureUntrackedOptions = {},
): Promise<CaptureUntrackedResult> {
  const excludePaths = options.excludePaths ?? [];
  const paths = await listUntrackedFiles(workspaceRoot);
  const files: UntrackedFileEntry[] = [];
  const invalidReasons: string[] = [];

  for (const filePath of paths) {
    if (isExcluded(filePath, excludePaths)) {
      continue;
    }
    const fullPath = join(workspaceRoot, filePath);
    const fileStat = await lstat(fullPath);

    if (!fileStat.isFile() && !fileStat.isSymbolicLink()) {
      invalidReasons.push(`special file not allowed: ${filePath}`);
      continue;
    }

    if (fileStat.isSymbolicLink()) {
      const linkTarget = await readlink(fullPath);
      const resolved = resolve(dirname(fullPath), linkTarget);
      if (!isInside(resolved, workspaceRoot)) {
        invalidReasons.push(`symlink escape: ${filePath}`);
        continue;
      }
      files.push({
        path: toPosix(filePath),
        mode: fileStat.mode,
        content: Buffer.from(linkTarget, 'utf8'),
        isSymlink: true,
        linkTarget,
      });
      continue;
    }

    const content = await readFile(fullPath);
    files.push({
      path: toPosix(filePath),
      mode: fileStat.mode,
      content,
      isSymlink: false,
      linkTarget: null,
    });
  }

  const manifest: UntrackedManifest = { schemaVersion: 1, files };
  const publicManifest = toPublicUntrackedManifest(manifest);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    join(artifactDir, 'untracked-manifest.json'),
    `${JSON.stringify(publicManifest, null, 2)}\n`,
    'utf8',
  );

  const archiveBytes = serializeUntrackedArchive(manifest);
  let archivePath: string | null = null;
  if (options.persistArchive !== false) {
    archivePath = join(artifactDir, 'untracked.tar.gz');
    await writeFile(archivePath, archiveBytes);
  }

  return {
    manifest,
    publicManifest,
    archiveBytes,
    archivePath,
    invalidReason: invalidReasons.length > 0 ? invalidReasons.join('; ') : null,
  };
}

export async function applyGitPatch(workspaceRoot: string, patchContent: string): Promise<number> {
  if (patchContent.trim().length === 0) {
    return 0;
  }
  return new Promise<number>((resolvePromise) => {
    const child = spawn('git', ['apply', '--binary', '-'], {
      cwd: workspaceRoot,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.on('error', () => {
      resolvePromise(1);
    });
    child.on('close', (code) => {
      resolvePromise(code ?? 1);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(patchContent);
  });
}

export async function applyUntrackedManifest(
  targetWorkspaceRoot: string,
  manifest: UntrackedManifest,
): Promise<void> {
  for (const file of manifest.files) {
    const targetPath = resolve(targetWorkspaceRoot, file.path);
    if (!isInside(targetPath, targetWorkspaceRoot)) {
      throw new Error(`untracked path escapes workspace: ${file.path}`);
    }
    await mkdir(dirname(targetPath), { recursive: true });
    if (file.isSymlink) {
      await symlink(file.linkTarget ?? file.content.toString('utf8'), targetPath);
      continue;
    }
    await writeFile(targetPath, file.content);
    if (file.mode !== 0) {
      await chmod(targetPath, file.mode & 0o7777);
    }
  }
}

export interface ReconstructCandidateInput {
  readonly seedRepositoryPath: string;
  readonly repositoryCommit: string;
  readonly targetWorkspaceRoot: string;
  readonly patchContent: string;
  readonly untrackedManifest: UntrackedManifest | null;
  readonly overlayPaths: readonly string[];
}

export interface ReconstructCandidateResult {
  readonly success: boolean;
  readonly finalFingerprint: string;
  readonly invalidReason: string | null;
}

export async function reconstructCandidate(
  input: ReconstructCandidateInput,
): Promise<ReconstructCandidateResult> {
  await rm(input.targetWorkspaceRoot, { recursive: true, force: true });
  await mkdir(input.targetWorkspaceRoot, { recursive: true });
  await cloneDetachedRepository({
    sourcePath: input.seedRepositoryPath,
    targetPath: input.targetWorkspaceRoot,
    commit: input.repositoryCommit,
  });

  const applyResult = await applyGitPatch(input.targetWorkspaceRoot, input.patchContent);
  if (applyResult !== 0) {
    return {
      success: false,
      finalFingerprint: '',
      invalidReason: 'patch apply failed',
    };
  }

  if (input.untrackedManifest !== null) {
    await applyUntrackedManifest(input.targetWorkspaceRoot, input.untrackedManifest);
  }

  const finalFingerprint = await computeTreeFingerprint(input.targetWorkspaceRoot);
  return { success: true, finalFingerprint, invalidReason: null };
}

export async function manifestsEqual(workspaceA: string, workspaceB: string): Promise<boolean> {
  const fpA = await computeTreeFingerprint(workspaceA);
  const fpB = await computeTreeFingerprint(workspaceB);
  return fpA === fpB;
}

export function hashManifest(manifest: UntrackedManifest): string {
  return createHash('sha256').update(serializeArchivePayload(manifest)).digest('hex');
}
