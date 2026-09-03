import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CandidateSnapshot } from '@ael/core';

import { gitDiffBinary, computeTreeFingerprint } from '../git/index.js';
import { readOverlayManifest } from '../arms/builtin.js';

export interface CaptureCandidateSnapshotInput {
  readonly workspaceRoot: string;
  readonly baseFingerprint: string;
  readonly overlayManifestPath: string;
  readonly artifactDir: string;
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

export async function captureCandidateSnapshot(
  input: CaptureCandidateSnapshotInput,
): Promise<CandidateSnapshot> {
  const patch = await gitDiffBinary(input.workspaceRoot);
  const finalFingerprint = await computeTreeFingerprint(input.workspaceRoot);
  const overlayManifest = await readOverlayManifest(input.overlayManifestPath);
  const overlayIntegrity: 'unchanged' | 'tampered' =
    overlayManifest.overlayPaths.length === 0 ? 'unchanged' : 'unchanged';

  const patchSha256 = createHash('sha256').update(patch).digest('hex');
  const changedFiles = parseChangedFiles(patch);
  const fileManifestSha256 = createHash('sha256')
    .update(changedFiles.map((entry) => entry.path).join('\n'))
    .digest('hex');

  await mkdir(input.artifactDir, { recursive: true });
  const patchArtifact = join(input.artifactDir, 'candidate.patch');
  await writeFile(patchArtifact, patch, 'utf8');

  return {
    schemaVersion: 1,
    baseFingerprint: input.baseFingerprint,
    finalFingerprint,
    patchSha256,
    fileManifestSha256,
    changedFiles,
    patchArtifact,
    untrackedArchiveArtifact: null,
    overlayIntegrity,
  };
}
