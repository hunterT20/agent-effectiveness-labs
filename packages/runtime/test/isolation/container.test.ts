import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ContainerIsolationProvider, isDockerAvailable } from '../../src/isolation/container.js';

const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)('container isolation', () => {
  it('doctor records observed capabilities from probe results', async () => {
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
});

describe('docker availability', () => {
  it('reports boolean without throwing', async () => {
    const available = await isDockerAvailable();
    expect(typeof available).toBe('boolean');
  });
});
