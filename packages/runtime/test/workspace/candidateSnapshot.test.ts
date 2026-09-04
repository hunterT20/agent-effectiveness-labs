import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { cloneDetachedRepository } from '../../src/git/clone.js';
import { computeTreeFingerprint } from '../../src/git/fingerprint.js';
import {
  captureCandidateSnapshot,
  checkOverlayIntegrity,
  parseGitNameStatus,
} from '../../src/workspace/candidateSnapshot.js';
import { materializeArm } from '../../src/arms/builtin.js';
import { createTempSeedRepo, runGitIn } from '../helpers/tempSeedRepo.js';

describe('parseGitNameStatus', () => {
  it('parses A/M/D/R status lines', () => {
    const parsed = parseGitNameStatus(
      ['A\tadded.txt', 'M\tmodified.txt', 'D\tdeleted.txt', 'R100\told.txt\tnew.txt', ''].join('\n'),
    );
    expect(parsed).toEqual([
      { path: 'added.txt', changeType: 'added' },
      { path: 'modified.txt', changeType: 'modified' },
      { path: 'deleted.txt', changeType: 'deleted' },
      { path: 'new.txt', changeType: 'renamed', oldPath: 'old.txt' },
    ]);
  });
});

describe('candidate snapshot name-status and overlay integrity', () => {
  it('records git A/M/D/R changes and excludes .ael prompts', async () => {
    const seed = await createTempSeedRepo();
    const workspace = mkdtempSync(join(tmpdir(), 'ael-ns-'));
    await cloneDetachedRepository({
      sourcePath: seed.repoPath,
      targetPath: workspace,
      commit: seed.commit,
    });
    writeFileSync(join(workspace, 'src', 'answer.txt'), 'changed\n', 'utf8');
    writeFileSync(join(workspace, 'added.txt'), 'new\n', 'utf8');
    await runGitIn(workspace, ['add', 'added.txt']);
    await runGitIn(workspace, ['rm', 'README.md']);
    mkdirSync(join(workspace, '.ael'), { recursive: true });
    writeFileSync(join(workspace, '.ael', 'prompt.md'), 'secret prompt\n', 'utf8');

    const overlayManifest = join(workspace, 'overlay.json');
    writeFileSync(overlayManifest, '{"overlayPaths":[],"fingerprint":""}\n', 'utf8');
    const snapshot = await captureCandidateSnapshot({
      workspaceRoot: workspace,
      baseFingerprint: await computeTreeFingerprint(workspace),
      overlayManifestPath: overlayManifest,
      artifactDir: mkdtempSync(join(tmpdir(), 'ael-ns-art-')),
    });

    const types = Object.fromEntries(snapshot.changedFiles.map((entry) => [entry.path, entry]));
    expect(types['added.txt']?.changeType).toBe('added');
    expect(types['README.md']?.changeType).toBe('deleted');
    expect(types['src/answer.txt']?.changeType).toBe('modified');
    expect(snapshot.changedFiles.some((entry) => entry.path.startsWith('.ael'))).toBe(false);
  });

  it('records git renames from name-status', async () => {
    const seed = await createTempSeedRepo();
    const workspace = mkdtempSync(join(tmpdir(), 'ael-ren-'));
    await cloneDetachedRepository({
      sourcePath: seed.repoPath,
      targetPath: workspace,
      commit: seed.commit,
    });
    await runGitIn(workspace, ['mv', 'README.md', 'README.moved.md']);
    const overlayManifest = join(workspace, 'overlay.json');
    writeFileSync(overlayManifest, '{"overlayPaths":[],"fingerprint":""}\n', 'utf8');
    const snapshot = await captureCandidateSnapshot({
      workspaceRoot: workspace,
      baseFingerprint: await computeTreeFingerprint(workspace),
      overlayManifestPath: overlayManifest,
      artifactDir: mkdtempSync(join(tmpdir(), 'ael-ren-art-')),
    });
    const renamed = snapshot.changedFiles.find((entry) => entry.path === 'README.moved.md');
    expect(renamed?.changeType).toBe('renamed');
    expect(renamed?.oldPath).toBe('README.md');
  });

  it('fingerprints only overlay-owned paths', async () => {
    const seed = await createTempSeedRepo();
    const suiteRoot = mkdtempSync(join(tmpdir(), 'ael-overlay-suite-'));
    mkdirSync(join(suiteRoot, 'overlays', 'marker'), { recursive: true });
    writeFileSync(join(suiteRoot, 'overlays', 'marker', 'overlay-marker.txt'), 'overlay-ok\n', 'utf8');

    const workspace = mkdtempSync(join(tmpdir(), 'ael-overlay-ws-'));
    await cloneDetachedRepository({
      sourcePath: seed.repoPath,
      targetPath: workspace,
      commit: seed.commit,
    });
    const isolatedHomeRoot = mkdtempSync(join(tmpdir(), 'ael-home-'));
    const overlayManifestPath = join(suiteRoot, 'arm-materialization.json');
    await materializeArm({
      workspaceRoot: workspace,
      trialId: 't1',
      suiteRoot,
      overlayManifestPath,
      isolatedHomeRoot,
      arm: {
        schemaVersion: 1,
        id: 'overlay-arm',
        name: 'overlay',
        actions: [{ type: 'workspace-overlay', source: './overlays/marker' }],
      },
    });

    const before = await checkOverlayIntegrity(workspace, overlayManifestPath);
    expect(before.overlayIntegrity).toBe('unchanged');
    expect(before.overlayPaths).toContain('overlay-marker.txt');

    writeFileSync(join(workspace, 'src', 'answer.txt'), 'not-overlay\n', 'utf8');
    const afterNonOverlay = await checkOverlayIntegrity(workspace, overlayManifestPath);
    expect(afterNonOverlay.overlayIntegrity).toBe('unchanged');

    writeFileSync(join(workspace, 'overlay-marker.txt'), 'tampered\n', 'utf8');
    const afterOverlay = await checkOverlayIntegrity(workspace, overlayManifestPath);
    expect(afterOverlay.overlayIntegrity).toBe('tampered');
  });
});
