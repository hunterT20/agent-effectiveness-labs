import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ProtectedBlobStore } from '../../src/artifacts/encryption.js';
import { createRunKeySourceFromHex } from '../../src/artifacts/runKey.js';
import { cloneDetachedRepository } from '../../src/git/clone.js';
import { computeTreeFingerprint } from '../../src/git/fingerprint.js';
import { captureCandidateSnapshot } from '../../src/workspace/candidateSnapshot.js';
import { createTempSeedRepo } from '../helpers/tempSeedRepo.js';

const RUN_KEY_HEX = 'b'.repeat(64);

describe('protected candidate snapshot integration', () => {
  it('stores encrypted blobs with public hash/size/ref only', async () => {
    const seed = await createTempSeedRepo();
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-protected-snap-'));
    const store = new ProtectedBlobStore(experimentRoot, createRunKeySourceFromHex(RUN_KEY_HEX));
    const workspace = mkdtempSync(join(tmpdir(), 'ael-protected-ws-'));
    await cloneDetachedRepository({
      sourcePath: seed.repoPath,
      targetPath: workspace,
      commit: seed.commit,
    });
    writeFileSync(join(workspace, 'notes.txt'), 'extra\n', 'utf8');
    const overlayManifest = join(workspace, 'overlay.json');
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
    expect(snapshot.protectedUntrackedRef).not.toBeNull();
    expect(snapshot.patchArtifact.startsWith('protected-blobs/')).toBe(true);
    expect(existsSync(join(artifactDir, 'candidate.patch'))).toBe(false);
    expect(existsSync(join(artifactDir, 'untracked.tar.gz'))).toBe(false);

    const publicManifest = JSON.parse(
      readFileSync(join(artifactDir, 'untracked-manifest.json'), 'utf8'),
    ) as {
      files: Array<{ path: string; sha256: string; sizeBytes: number; contentBase64?: string }>;
    };
    expect(publicManifest.files[0]?.path).toBe('notes.txt');
    expect(publicManifest.files[0]?.sha256).toHaveLength(64);
    expect(publicManifest.files[0]?.sizeBytes).toBeGreaterThan(0);
    expect(publicManifest.files[0]?.contentBase64).toBeUndefined();
    expect(JSON.stringify(publicManifest)).not.toContain('contentBase64');
  });
});
