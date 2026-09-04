import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DirectoryOnlyIsolationProvider } from '../../src/isolation/directoryOnly.js';
import { materializeArm, readArmMaterialization } from '../../src/arms/builtin.js';
import { cloneDetachedRepository } from '../../src/git/clone.js';
import { createTempSeedRepo } from '../helpers/tempSeedRepo.js';

describe('materializeArm', () => {
  it('persists action hashes, overlay fingerprint, env, argv, and plugin dirs', async () => {
    const seed = await createTempSeedRepo();
    const suiteRoot = mkdtempSync(join(tmpdir(), 'ael-arm-suite-'));
    mkdirSync(join(suiteRoot, 'overlays', 'marker'), { recursive: true });
    mkdirSync(join(suiteRoot, 'plugins', 'example'), { recursive: true });
    writeFileSync(join(suiteRoot, 'overlays', 'marker', 'overlay-marker.txt'), 'ok\n', 'utf8');
    writeFileSync(join(suiteRoot, 'plugins', 'example', 'plugin.json'), '{}\n', 'utf8');

    const workspace = mkdtempSync(join(tmpdir(), 'ael-arm-ws-'));
    await cloneDetachedRepository({
      sourcePath: seed.repoPath,
      targetPath: workspace,
      commit: seed.commit,
    });
    const isolatedHomeRoot = mkdtempSync(join(tmpdir(), 'ael-arm-home-'));
    const overlayManifestPath = join(suiteRoot, 'arm-materialization.json');
    const result = await materializeArm({
      workspaceRoot: workspace,
      trialId: 't1',
      suiteRoot,
      overlayManifestPath,
      isolatedHomeRoot,
      arm: {
        schemaVersion: 1,
        id: 'treatment',
        name: 'treatment',
        actions: [
          { type: 'workspace-overlay', source: './overlays/marker' },
          { type: 'environment', variables: { AEL_ARM_MARKER: 'treatment' } },
          { type: 'agent-argument', args: ['--hint', 'treatment'] },
          { type: 'plugin-directory', path: './plugins/example' },
        ],
      },
    });

    expect(result.actionHashes).toHaveLength(4);
    expect(result.overlayPaths).toEqual(['overlay-marker.txt']);
    expect(result.overlayFingerprint).toHaveLength(64);
    expect(result.environment.AEL_ARM_MARKER).toBe('treatment');
    expect(result.argvAdditions).toEqual(['--hint', 'treatment']);
    expect(result.pluginDirs[0]?.endsWith(join('plugins', 'example'))).toBe(true);

    const persisted = await readArmMaterialization(overlayManifestPath);
    expect(persisted).toEqual(result);
    expect(readFileSync(join(workspace, 'overlay-marker.txt'), 'utf8')).toBe('ok\n');
  });

  it('copies home-overlay into isolatedHomeRoot outside the workspace', async () => {
    const seed = await createTempSeedRepo();
    const suiteRoot = mkdtempSync(join(tmpdir(), 'ael-home-suite-'));
    mkdirSync(join(suiteRoot, 'home-files'), { recursive: true });
    writeFileSync(join(suiteRoot, 'home-files', 'marker.txt'), 'home-ok\n', 'utf8');
    const workspace = mkdtempSync(join(tmpdir(), 'ael-home-ws-'));
    await cloneDetachedRepository({
      sourcePath: seed.repoPath,
      targetPath: workspace,
      commit: seed.commit,
    });
    const isolatedHomeRoot = mkdtempSync(join(tmpdir(), 'ael-iso-home-'));
    await materializeArm({
      workspaceRoot: workspace,
      trialId: 't1',
      suiteRoot,
      overlayManifestPath: join(suiteRoot, 'arm-materialization.json'),
      isolatedHomeRoot,
      arm: {
        schemaVersion: 1,
        id: 'home',
        name: 'home',
        actions: [{ type: 'home-overlay', source: './home-files' }],
      },
    });
    expect(readFileSync(join(isolatedHomeRoot, 'home', 'marker.txt'), 'utf8')).toBe('home-ok\n');
  });

  it('fails when setup mutates paths outside allowedWritePaths', async () => {
    const seed = await createTempSeedRepo();
    const suiteRoot = mkdtempSync(join(tmpdir(), 'ael-setup-suite-'));
    const workspace = mkdtempSync(join(tmpdir(), 'ael-setup-ws-'));
    await cloneDetachedRepository({
      sourcePath: seed.repoPath,
      targetPath: workspace,
      commit: seed.commit,
    });
    const isolatedHomeRoot = mkdtempSync(join(tmpdir(), 'ael-setup-home-'));
    const isolation = new DirectoryOnlyIsolationProvider();
    await expect(
      materializeArm({
        workspaceRoot: workspace,
        trialId: 't1',
        suiteRoot,
        overlayManifestPath: join(suiteRoot, 'arm-materialization.json'),
        isolatedHomeRoot,
        isolation,
        arm: {
          schemaVersion: 1,
          id: 'setup',
          name: 'setup',
          actions: [
            {
              type: 'sandboxed-setup-command',
              command: process.execPath,
              args: ['-e', "require('fs').writeFileSync('outside.txt', 'nope')"],
              allowedWritePaths: ['src'],
            },
          ],
        },
      }),
    ).rejects.toThrow(/undeclared paths/);
  });
});
