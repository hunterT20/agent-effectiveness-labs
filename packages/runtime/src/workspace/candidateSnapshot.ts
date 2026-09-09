import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import type { CandidateFileEntry, CandidateSnapshot } from '@ael/core';
import { CandidateSnapshotSchema } from '@ael/core';

import type { ProtectedBlobStore } from '../artifacts/encryption.js';
import { ProtectedBlobEnvelopeSchema } from '../artifacts/schemas.js';
import { gitDiffBinary, computeTreeFingerprint, runGit } from '../git/index.js';
import { readOverlayManifest } from '../arms/builtin.js';
import { captureUntrackedFiles } from './reconstructCandidate.js';
import { evaluateScopePolicy, ScopeEvaluationSchema, type ScopeEvaluation } from './scopePolicy.js';
import { computePathSetFingerprint } from './treeManifest.js';

export interface CandidateScopePolicy {
  readonly allowedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly maxChangedFiles: number | null;
}

export interface CaptureCandidateSnapshotInput {
  readonly workspaceRoot: string;
  readonly baseFingerprint: string;
  readonly overlayManifestPath: string;
  readonly artifactDir: string;
  readonly protectedBlobStore?: ProtectedBlobStore;
  /** Fixture scope policy; when omitted no scope violation can be reported. */
  readonly scopePolicy?: CandidateScopePolicy;
  /** Harness-owned workspace-relative paths never treated as candidate output (e.g. `.ael`). */
  readonly excludePaths?: readonly string[];
}

export const ProtectedBlobRefSchema = z
  .object({
    blobId: z.string().min(1),
    plaintextSha256: z.string().length(64),
    sizeBytes: z.number().int().nonnegative(),
    envelope: ProtectedBlobEnvelopeSchema,
  })
  .strict();

export type ProtectedBlobRef = z.infer<typeof ProtectedBlobRefSchema>;

export const PublicCandidateSnapshotSchema = CandidateSnapshotSchema.extend({
  protectedPatchRef: ProtectedBlobRefSchema.nullable(),
  protectedUntrackedRef: ProtectedBlobRefSchema.nullable(),
  /** Arm-owned overlay files excluded from the candidate. */
  overlayPaths: z.array(z.string()),
  scope: ScopeEvaluationSchema,
  /** Non-null when the candidate cannot be reconstructed faithfully (symlink escape, special file). */
  candidateInvalidReason: z.string().nullable(),
});

export type PublicCandidateSnapshot = z.infer<typeof PublicCandidateSnapshotSchema>;

export const HARNESS_EXCLUDED_PATHS: readonly string[] = ['.ael'];

function toPosix(path: string): string {
  return path.split('\\').join('/');
}

function isUnderAny(filePath: string, prefixes: readonly string[]): boolean {
  const posixPath = toPosix(filePath);
  return prefixes.some((prefix) => {
    const normalized = toPosix(prefix).replace(/\/+$/, '');
    return posixPath === normalized || posixPath.startsWith(`${normalized}/`);
  });
}

/** Parses `git diff --name-status` output (`A`/`M`/`D`/`R`/`C`, including `R100`). */
export function parseGitNameStatus(output: string): CandidateFileEntry[] {
  const entries: CandidateFileEntry[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.length === 0) {
      continue;
    }
    const columns = line.split('\t');
    const statusColumn = columns[0] ?? '';
    const statusCode = statusColumn.charAt(0);
    if ((statusCode === 'R' || statusCode === 'C') && columns.length >= 3) {
      const oldPath = columns[1];
      const newPath = columns[2];
      if (oldPath !== undefined && newPath !== undefined) {
        entries.push({ path: toPosix(newPath), changeType: 'renamed', oldPath: toPosix(oldPath) });
      }
      continue;
    }
    const path = columns[1];
    if (path === undefined) {
      continue;
    }
    if (statusCode === 'A') {
      entries.push({ path: toPosix(path), changeType: 'added' });
    } else if (statusCode === 'D') {
      entries.push({ path: toPosix(path), changeType: 'deleted' });
    } else {
      entries.push({ path: toPosix(path), changeType: 'modified' });
    }
  }
  return entries;
}

async function listTrackedChanges(workspaceRoot: string): Promise<CandidateFileEntry[]> {
  const result = await runGit(['diff', '--name-status', '-M', 'HEAD'], { cwd: workspaceRoot });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`git diff --name-status failed: ${result.stderr}`);
  }
  return parseGitNameStatus(result.stdout);
}

export async function checkOverlayIntegrity(
  workspaceRoot: string,
  overlayManifestPath: string,
): Promise<{ overlayIntegrity: 'unchanged' | 'tampered'; overlayPaths: readonly string[] }> {
  const overlayManifest = await readOverlayManifest(overlayManifestPath);
  if (overlayManifest.overlayPaths.length === 0) {
    return { overlayIntegrity: 'unchanged', overlayPaths: [] };
  }
  const currentFingerprint = await computePathSetFingerprint(
    workspaceRoot,
    overlayManifest.overlayPaths,
  );
  return {
    overlayIntegrity: currentFingerprint === overlayManifest.fingerprint ? 'unchanged' : 'tampered',
    overlayPaths: overlayManifest.overlayPaths,
  };
}

export async function captureCandidateSnapshot(
  input: CaptureCandidateSnapshotInput,
): Promise<PublicCandidateSnapshot> {
  const { overlayIntegrity, overlayPaths } = await checkOverlayIntegrity(
    input.workspaceRoot,
    input.overlayManifestPath,
  );
  const excludePaths = [...(input.excludePaths ?? HARNESS_EXCLUDED_PATHS), ...overlayPaths];

  const patch = await gitDiffBinary(input.workspaceRoot);
  const finalFingerprint = await computeTreeFingerprint(input.workspaceRoot);
  const trackedChanges = (await listTrackedChanges(input.workspaceRoot)).filter(
    (entry) => !isUnderAny(entry.path, excludePaths),
  );

  await mkdir(input.artifactDir, { recursive: true });
  const untracked = await captureUntrackedFiles(input.workspaceRoot, input.artifactDir, {
    excludePaths,
    persistArchive: input.protectedBlobStore === undefined,
  });

  const changedFiles: CandidateSnapshot['changedFiles'] = [
    ...trackedChanges,
    ...untracked.manifest.files.map((file): CandidateFileEntry => ({
      path: file.path,
      changeType: 'added',
    })),
  ];

  const scope: ScopeEvaluation = evaluateScopePolicy({
    changedPaths: changedFiles.map((entry) => entry.path),
    allowedPaths: input.scopePolicy?.allowedPaths ?? [],
    forbiddenPaths: input.scopePolicy?.forbiddenPaths ?? [],
    maxChangedFiles: input.scopePolicy?.maxChangedFiles ?? null,
  });

  const patchSha256 = createHash('sha256').update(patch).digest('hex');
  const fileManifestSha256 = createHash('sha256')
    .update(changedFiles.map((entry) => entry.path).join('\n'))
    .digest('hex');

  let patchArtifact = join(input.artifactDir, 'candidate.patch');
  let untrackedArchiveArtifact: string | null = untracked.archivePath;
  let protectedPatchRef: ProtectedBlobRef | null = null;
  let protectedUntrackedRef: ProtectedBlobRef | null = null;

  if (input.protectedBlobStore !== undefined) {
    const patchBytes = Buffer.from(patch, 'utf8');
    const patchBlob = await input.protectedBlobStore.encryptAndStore(patchBytes);
    protectedPatchRef = {
      blobId: patchBlob.blobId,
      plaintextSha256: patchBlob.envelope.plaintextSha256,
      sizeBytes: patchBytes.length,
      envelope: patchBlob.envelope,
    };
    patchArtifact = `protected-blobs/${patchBlob.blobId}`;

    const untrackedBlob = await input.protectedBlobStore.encryptAndStore(untracked.archiveBytes);
    protectedUntrackedRef = {
      blobId: untrackedBlob.blobId,
      plaintextSha256: untrackedBlob.envelope.plaintextSha256,
      sizeBytes: untracked.archiveBytes.length,
      envelope: untrackedBlob.envelope,
    };
    untrackedArchiveArtifact = `protected-blobs/${untrackedBlob.blobId}`;
  } else {
    await writeFile(patchArtifact, patch, 'utf8');
  }

  return {
    schemaVersion: 1,
    baseFingerprint: input.baseFingerprint,
    finalFingerprint,
    patchSha256,
    fileManifestSha256,
    changedFiles,
    patchArtifact,
    untrackedArchiveArtifact,
    overlayIntegrity,
    protectedPatchRef,
    protectedUntrackedRef,
    overlayPaths: [...overlayPaths],
    scope,
    candidateInvalidReason: untracked.invalidReason,
  };
}
