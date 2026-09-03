import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, lstat, readlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';

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

export interface CaptureUntrackedResult {
  readonly manifest: UntrackedManifest;
  readonly archivePath: string;
  readonly invalidReason: string | null;
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

export async function captureUntrackedFiles(
  workspaceRoot: string,
  artifactDir: string,
): Promise<CaptureUntrackedResult> {
  const paths = await listUntrackedFiles(workspaceRoot);
  const files: UntrackedFileEntry[] = [];
  let invalidReason: string | null = null;

  for (const filePath of paths) {
    const fullPath = join(workspaceRoot, filePath);
    const fileStat = await lstat(fullPath);

    if (!fileStat.isFile() && !fileStat.isSymbolicLink()) {
      invalidReason = `special file not allowed: ${filePath}`;
      continue;
    }

    if (fileStat.isSymbolicLink()) {
      const linkTarget = await readlink(fullPath);
      const resolved = resolve(dirname(fullPath), linkTarget);
      if (!isInside(resolved, workspaceRoot)) {
        invalidReason = `symlink escape: ${filePath}`;
        continue;
      }
      files.push({
        path: filePath,
        mode: fileStat.mode,
        content: Buffer.from(linkTarget, 'utf8'),
        isSymlink: true,
        linkTarget,
      });
      continue;
    }

    const content = await readFile(fullPath);
    files.push({
      path: filePath,
      mode: fileStat.mode,
      content,
      isSymlink: false,
      linkTarget: null,
    });
  }

  const manifest: UntrackedManifest = { schemaVersion: 1, files };
  await mkdir(artifactDir, { recursive: true });
  const manifestPath = join(artifactDir, 'untracked-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');

  const archivePath = join(artifactDir, 'untracked.tar.gz');
  const gzip = createGzip();
  const output = createWriteStream(archivePath);
  const tarContent = Buffer.from(JSON.stringify(manifest));
  await pipeline(Readable.from([tarContent]), gzip, output);

  return { manifest, archivePath, invalidReason };
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
  await mkdir(input.targetWorkspaceRoot, { recursive: true });
  await cloneDetachedRepository({
    sourcePath: input.seedRepositoryPath,
    targetPath: input.targetWorkspaceRoot,
    commit: input.repositoryCommit,
  });

  if (input.patchContent.trim().length > 0) {
    const applyResult = await new Promise<number>((resolve) => {
      const child = spawn('git', ['apply', '--binary', '-'], {
        cwd: input.targetWorkspaceRoot,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.write(input.patchContent);
      child.stdin.end();
      child.on('close', (code) => {
        resolve(code ?? 1);
      });
    });
    if (applyResult !== 0) {
      return {
        success: false,
        finalFingerprint: '',
        invalidReason: 'patch apply failed',
      };
    }
  }

  if (input.untrackedManifest !== null) {
    for (const file of input.untrackedManifest.files) {
      const targetPath = join(input.targetWorkspaceRoot, file.path);
      await mkdir(join(targetPath, '..'), { recursive: true });
      if (file.isSymlink) {
        const { symlink } = await import('node:fs/promises');
        await symlink(file.linkTarget ?? file.content.toString('utf8'), targetPath);
      } else {
        await writeFile(targetPath, file.content);
        if (file.mode !== 0) {
          const { chmod } = await import('node:fs/promises');
          await chmod(targetPath, file.mode);
        }
      }
    }
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
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}
