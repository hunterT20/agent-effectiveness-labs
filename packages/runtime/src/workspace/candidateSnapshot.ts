import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CandidateSnapshot } from '@ael/core';

import type { ProtectedBlobStore } from '../artifacts/encryption.js';
import { gitDiffBinary, computeTreeFingerprint } from '../git/index.js';
import { readOverlayManifest } from '../arms/builtin.js';
import { captureUntrackedFiles } from './reconstructCandidate.js';

export interface CaptureCandidateSnapshotInput {
  readonly workspaceRoot: string;
  readonly baseFingerprint: string;
  readonly overlayManifestPath: string;
  readonly artifactDir: string;
  readonly protectedBlobStore?: ProtectedBlobStore;
}

export interface ProtectedBlobRef {
  readonly blobId: string;
  readonly plaintextSha256: string;
  readonly sizeBytes: number;
}

export interface PublicCandidateSnapshot extends CandidateSnapshot {
  readonly protectedPatchRef: ProtectedBlobRef | null;
  readonly protectedUntrackedRef: ProtectedBlobRef | null;
}

function parseChangedFiles(patch: string): CandidateSnapshot['changedFiles'] {
  const changedFiles: CandidateSnapshot['changedFiles'] = [];
  const lines = patch.split('\n');
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (match?.[2] !== undefined) {
        changedFiles.push({ path: match[2], changeType: 'modified' });
      }
    }
  }
  return changedFiles;
}

async function checkOverlayIntegrity(
  workspaceRoot: string,
  overlayManifestPath: string,
): Promise<'unchanged' | 'tampered'> {
  const overlayManifest = await readOverlayManifest(overlayManifestPath);
  const currentFingerprint = await computeTreeFingerprint(workspaceRoot);
  for (const overlayPath of overlayManifest.overlayPaths) {
    const overlayFile = join(workspaceRoot, overlayPath);
    try {
      await readFile(overlayFile);
    } catch {
      return 'tampered';
    }
  }
  if (
    overlayManifest.overlayPaths.length > 0 &&
    currentFingerprint !== overlayManifest.fingerprint
  ) {
    return 'tampered';
  }
  return 'unchanged';
}

export async function captureCandidateSnapshot(
  input: CaptureCandidateSnapshotInput,
): Promise<PublicCandidateSnapshot> {
  const patch = await gitDiffBinary(input.workspaceRoot);
  const finalFingerprint = await computeTreeFingerprint(input.workspaceRoot);
  const overlayIntegrity = await checkOverlayIntegrity(
    input.workspaceRoot,
    input.overlayManifestPath,
  );

  const untracked = await captureUntrackedFiles(input.workspaceRoot, input.artifactDir);
  if (untracked.invalidReason !== null) {
    throw new Error(`invalid candidate: ${untracked.invalidReason}`);
  }

  const patchSha256 = createHash('sha256').update(patch).digest('hex');
  const changedFiles = parseChangedFiles(patch);
  const fileManifestSha256 = createHash('sha256')
    .update(
      [
        ...changedFiles.map((entry) => entry.path),
        ...untracked.manifest.files.map((f) => f.path),
      ].join('\n'),
    )
    .digest('hex');

  await mkdir(input.artifactDir, { recursive: true });

  let patchArtifact = join(input.artifactDir, 'candidate.patch');
  let untrackedArchiveArtifact: string | null = untracked.archivePath;
  let protectedPatchRef: ProtectedBlobRef | null = null;
  let protectedUntrackedRef: ProtectedBlobRef | null = null;

  if (input.protectedBlobStore !== undefined) {
    const patchBlob = await input.protectedBlobStore.encryptAndStore(Buffer.from(patch, 'utf8'));
    protectedPatchRef = {
      blobId: patchBlob.blobId,
      plaintextSha256: patchBlob.envelope.plaintextSha256,
      sizeBytes: Buffer.byteLength(patch),
    };
    patchArtifact = `protected-blobs/${patchBlob.blobId}`;

    const untrackedBytes = await readFile(untracked.archivePath);
    const untrackedBlob = await input.protectedBlobStore.encryptAndStore(untrackedBytes);
    protectedUntrackedRef = {
      blobId: untrackedBlob.blobId,
      plaintextSha256: untrackedBlob.envelope.plaintextSha256,
      sizeBytes: untrackedBytes.length,
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
  };
}
