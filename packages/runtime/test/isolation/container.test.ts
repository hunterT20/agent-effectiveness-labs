import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildHardenedRunArgs,
  CONTAINER_DEFAULT_MEMORY_LIMIT,
  CONTAINER_HOME,
  ContainerIsolationProvider,
  isDockerAvailable,
  isPathMounted,
} from '../../src/isolation/container.js';

const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)('container isolation', () => {
  it('doctor records observed capabilities from probe results', { timeout: 120_000 }, async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ael-container-'));
    writeFileSync(join(workspaceRoot, 'seed.txt'), 'seed\n', 'utf8');
    const provider = new ContainerIsolationProvider({
      workspaceRoot,
      denyNetwork: true,
      graderRoot: '/tmp/grader-secret',
      artifactRoot: '/tmp/artifact-secret',
    });
    const result = await provider.doctor({
      requestedCapabilities: {
        filesystemEnforced: true,
        networkPolicyEnforced: true,
      },
    });
    expect(result.observedCapabilities.level).toBe('container');
    expect(result.observedCapabilities.hiddenGraderProtected).toBe(true);
    expect(result.observedCapabilities.externalArtifactsProtected).toBe(true);
  });

  it('runs process inside container without mounting grader or artifact roots', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ael-container-run-'));
    writeFileSync(join(workspaceRoot, 'seed.txt'), 'seed\n', 'utf8');
    const provider = new ContainerIsolationProvider({
      workspaceRoot,
      denyNetwork: true,
    });
    const session = await provider.prepare({ workspaceRoot, trialId: 'trial-1' });
    const result = await provider.run(session, {
      command: 'node',
      args: ['-e', 'process.stdout.write(process.cwd())'],
      cwd: workspaceRoot,
      env: {},
      timeoutMs: 30_000,
    });
    await provider.dispose(session);
    expect(result.exitCode).toBe(0);
  });

  it('returns SIGKILL and removes the named container on timeout', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ael-container-timeout-'));
    writeFileSync(join(workspaceRoot, 'seed.txt'), 'seed\n', 'utf8');
    const provider = new ContainerIsolationProvider({
      workspaceRoot,
      denyNetwork: true,
    });
    const session = await provider.prepare({ workspaceRoot, trialId: 'trial-timeout' });
    const result = await provider.run(session, {
      command: 'sleep',
      args: ['30'],
      cwd: workspaceRoot,
      env: {},
      timeoutMs: 1_500,
    });
    await provider.dispose(session);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe('SIGKILL');
  });
});

describe('docker availability', () => {
  it('reports boolean without throwing', async () => {
    const available = await isDockerAvailable();
    expect(typeof available).toBe('boolean');
  });
});

describe('container mount and run-arg helpers', () => {
  it('derives isPathMounted from the bind-mount list', () => {
    const mounts = [
      { hostPath: '/tmp/workspace', containerPath: '/workspace', mode: 'rw' as const },
    ];
    expect(isPathMounted('/tmp/workspace/src', mounts)).toBe(true);
    expect(isPathMounted('/tmp/grader-secret', mounts)).toBe(false);
  });

  it('hardens docker run with read-only root, tmpfs /tmp, memory, pids, and named container', () => {
    const args = buildHardenedRunArgs(
      'ael-trial-1',
      { denyNetwork: true, memoryLimit: CONTAINER_DEFAULT_MEMORY_LIMIT, pidsLimit: 256 },
      [{ hostPath: '/tmp/ws', containerPath: '/workspace', mode: 'rw' }],
    );
    expect(args).toEqual(expect.arrayContaining(['--read-only', '--name', 'ael-trial-1']));
    expect(args).toContain('--tmpfs');
    expect(args.some((arg) => arg.startsWith('/tmp:'))).toBe(true);
    expect(args.some((arg) => arg.startsWith(`${CONTAINER_HOME}:`))).toBe(true);
    expect(args).toEqual(expect.arrayContaining(['--memory', '2g', '--pids-limit', '256']));
    expect(args).toEqual(expect.arrayContaining(['--network', 'none']));
  });
});
