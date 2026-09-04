import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { cloneDetachedRepository, gitDiffBinary } from '../../src/git/clone.js';
import { computeTreeFingerprint } from '../../src/git/fingerprint.js';
import {
  captureUntrackedFiles,
  manifestsEqual,
  reconstructCandidate,
} from '../../src/workspace/reconstructCandidate.js';
import { captureCandidateSnapshot } from '../../src/workspace/candidateSnapshot.js';
import { createTempSeedRepo } from '../helpers/tempSeedRepo.js';

describe('reconstructCandidate', () => {
  it('reconstructs text changes with byte-level manifest equality', async () => {
    const seed = await createTempSeedRepo();
    const sourceWorkspace = mkdtempSync(join(tmpdir(), 'ael-src-'));
    await cloneDetachedRepository({
      sourcePath: seed.repoPath,
      targetPath: sourceWorkspace,
      commit: seed.commit,
    });
    writeFileSync(join(sourceWorkspace, 'src', 'answer.txt'), 'correct-answer\n', 'utf8');

    const patch = await gitDiffBinary(sourceWorkspace);
    const artifactDir = mkdtempSync(join(tmpdir(), 'ael-art-'));
    const untracked = await captureUntrackedFiles(sourceWorkspace, artifactDir);
    const targetWorkspace = mkdtempSync(join(tmpdir(), 'ael-target-'));
    const reconstructed = await reconstructCandidate({
      seedRepositoryPath: seed.repoPath,
      repositoryCommit: seed.commit,
      targetWorkspaceRoot: targetWorkspace,
      patchContent: patch,
      untrackedManifest: untracked.manifest,
      overlayPaths: [],
    });

    expect(reconstructed.success).toBe(true);
    expect(await manifestsEqual(sourceWorkspace, targetWorkspace)).toBe(true);
    expect(reconstructed.finalFingerprint).toBe(await computeTreeFingerprint(sourceWorkspace));
  });

  it('preserves binary files and executable bits', async () => {
    const seed = await createTempSeedRepo();
    const sourceWorkspace = mkdtempSync(join(tmpdir(), 'ael-bin-'));
    await cloneDetachedRepository({
      sourcePath: seed.repoPath,
      targetPath: sourceWorkspace,
      commit: seed.commit,
    });
    const binPath = join(sourceWorkspace, 'blob.bin');
    writeFileSync(binPath, Buffer.from([0, 1, 2, 255]));
    chmodSync(binPath, 0o755);

    const artifactDir = mkdtempSync(join(tmpdir(), 'ael-bin-art-'));
    const untracked = await captureUntrackedFiles(sourceWorkspace, artifactDir);
    expect(untracked.invalidReason).toBeNull();

    const targetWorkspace = mkdtempSync(join(tmpdir(), 'ael-bin-target-'));
    const reconstructed = await reconstructCandidate({
      seedRepositoryPath: seed.repoPath,
      repositoryCommit: seed.commit,
      targetWorkspaceRoot: targetWorkspace,
      patchContent: '',
      untrackedManifest: untracked.manifest,
      overlayPaths: [],
    });
    expect(reconstructed.success).toBe(true);
    const restored = readFileSync(join(targetWorkspace, 'blob.bin'));
    expect(Buffer.from(restored).equals(Buffer.from([0, 1, 2, 255]))).toBe(true);
  });

  it('invalidates trial on symlink escape in untracked capture', async () => {
    const seed = await createTempSeedRepo();
    const sourceWorkspace = mkdtempSync(join(tmpdir(), 'ael-sym-'));
    await cloneDetachedRepository({
      sourcePath: seed.repoPath,
      targetPath: sourceWorkspace,
      commit: seed.commit,
    });
    const { symlink } = await import('node:fs/promises');
    await symlink('/tmp/ael-escape-target.txt', join(sourceWorkspace, 'escape-link'));

    const artifactDir = mkdtempSync(join(tmpdir(), 'ael-sym-art-'));
    const untracked = await captureUntrackedFiles(sourceWorkspace, artifactDir);
    expect(untracked.invalidReason).toContain('symlink escape');
  });
});

describe('captureCandidateSnapshot integration', () => {
  it('captures untracked archive alongside patch', async () => {
    const seed = await createTempSeedRepo();
    const workspace = mkdtempSync(join(tmpdir(), 'ael-snap-'));
    await cloneDetachedRepository({
      sourcePath: seed.repoPath,
      targetPath: workspace,
      commit: seed.commit,
    });
    writeFileSync(join(workspace, 'notes.txt'), 'extra\n', 'utf8');
    const overlayManifest = join(workspace, 'overlay.json');
    writeFileSync(overlayManifest, '{"overlayPaths":[],"fingerprint":""}\n', 'utf8');
    const artifactDir = mkdtempSync(join(tmpdir(), 'ael-snap-art-'));
    const snapshot = await captureCandidateSnapshot({
      workspaceRoot: workspace,
      baseFingerprint: await computeTreeFingerprint(workspace),
      overlayManifestPath: overlayManifest,
      artifactDir,
    });
    expect(snapshot.untrackedArchiveArtifact).not.toBeNull();
  });
});
