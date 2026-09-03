import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ProtectedBlobStore } from '../../src/artifacts/encryption.js';
import { createRunKeySourceFromHex } from '../../src/artifacts/runKey.js';
import { captureCandidateSnapshot } from '../../src/workspace/candidateSnapshot.js';
import { cloneDetachedRepository } from '../../src/git/clone.js';
import { computeTreeFingerprint } from '../../src/git/fingerprint.js';

const RUN_KEY_HEX = 'b'.repeat(64);
const repoRoot = join(import.meta.dirname, '../../../../examples/minimal');
const seedRepo = join(repoRoot, 'seed-repo');

describe('protected candidate snapshot integration', () => {
  it('stores encrypted blobs with public hash/size/ref only', async () => {
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-protected-snap-'));
    const store = new ProtectedBlobStore(experimentRoot, createRunKeySourceFromHex(RUN_KEY_HEX));
    const workspace = mkdtempSync(join(tmpdir(), 'ael-protected-ws-'));
    await cloneDetachedRepository({
      sourcePath: seedRepo,
      targetPath: workspace,
      commit: '8fc35dac5eef18ad0e4d61a8e3ad6c6ba814511c',
    });
    const overlayManifest = join(workspace, 'overlay.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(overlayManifest, '{"overlayPaths":[],"fingerprint":""}\n', 'utf8');
    const artifactDir = mkdtempSync(join(tmpdir(), 'ael-protected-art-'));
    const snapshot = await captureCandidateSnapshot({
      workspaceRoot: workspace,
      baseFingerprint: await computeTreeFingerprint(workspace),
      overlayManifestPath: overlayManifest,
      artifactDir,
      protectedBlobStore: store,
    });
    expect(snapshot.protectedPatchRef).not.toBeNull();
    expect(snapshot.patchArtifact.startsWith('protected-blobs/')).toBe(true);
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(artifactDir, 'candidate.patch'))).toBe(false);
  });
});
