import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { cloneDetachedRepository } from '../../src/git/clone.js';
import { computeTreeFingerprint } from '../../src/git/fingerprint.js';
import {
  captureUntrackedFiles,
  manifestsEqual,
  reconstructCandidate,
} from '../../src/workspace/reconstructCandidate.js';
import { captureCandidateSnapshot } from '../../src/workspace/candidateSnapshot.js';

const repoRoot = join(import.meta.dirname, '../../../../examples/minimal');
const seedRepo = join(repoRoot, 'seed-repo');
const COMMIT = '8fc35dac5eef18ad0e4d61a8e3ad6c6ba814511c';

describe('reconstructCandidate', () => {
  it('reconstructs text changes with byte-level manifest equality', async () => {
    const sourceWorkspace = mkdtempSync(join(tmpdir(), 'ael-src-'));
    await cloneDetachedRepository({
      sourcePath: seedRepo,
      targetPath: sourceWorkspace,
      commit: COMMIT,
    });
    writeFileSync(join(sourceWorkspace, 'src', 'answer.txt'), 'correct-answer\n', 'utf8');

    const patch = await import('../../src/git/clone.js').then((m) =>
      m.gitDiffBinary(sourceWorkspace),
    );
    const artifactDir = mkdtempSync(join(tmpdir(), 'ael-art-'));
    const untracked = await captureUntrackedFiles(sourceWorkspace, artifactDir);
    const targetWorkspace = mkdtempSync(join(tmpdir(), 'ael-target-'));
    const reconstructed = await reconstructCandidate({
      seedRepositoryPath: seedRepo,
      repositoryCommit: COMMIT,
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
    const sourceWorkspace = mkdtempSync(join(tmpdir(), 'ael-bin-'));
    await cloneDetachedRepository({
      sourcePath: seedRepo,
      targetPath: sourceWorkspace,
      commit: COMMIT,
    });
    const binPath = join(sourceWorkspace, 'blob.bin');
    writeFileSync(binPath, Buffer.from([0, 1, 2, 255]));
    chmodSync(binPath, 0o755);

    const artifactDir = mkdtempSync(join(tmpdir(), 'ael-bin-art-'));
    const untracked = await captureUntrackedFiles(sourceWorkspace, artifactDir);
    expect(untracked.invalidReason).toBeNull();

    const targetWorkspace = mkdtempSync(join(tmpdir(), 'ael-bin-target-'));
    const reconstructed = await reconstructCandidate({
      seedRepositoryPath: seedRepo,
      repositoryCommit: COMMIT,
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
    const sourceWorkspace = mkdtempSync(join(tmpdir(), 'ael-sym-'));
    await cloneDetachedRepository({
      sourcePath: seedRepo,
      targetPath: sourceWorkspace,
      commit: COMMIT,
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
    const workspace = mkdtempSync(join(tmpdir(), 'ael-snap-'));
    await cloneDetachedRepository({
      sourcePath: seedRepo,
      targetPath: workspace,
      commit: COMMIT,
    });
    writeFileSync(join(workspace, 'notes.txt'), 'extra\n', 'utf8');
    const overlayManifest = join(workspace, 'overlay.json');
    writeFileSync(overlayManifest, '{"overlayPaths":[],"fingerprint":""}\n', 'utf8');
    const artifactDir = mkdtempSync(join(tmpdir(), 'ael-snap-art-'));
    const baseFingerprint = await computeTreeFingerprint(workspace);
    const snapshot = await captureCandidateSnapshot({
      workspaceRoot: workspace,
      baseFingerprint,
      overlayManifestPath: overlayManifest,
      artifactDir,
    });
    expect(snapshot.untrackedArchiveArtifact).not.toBeNull();
  });
});
