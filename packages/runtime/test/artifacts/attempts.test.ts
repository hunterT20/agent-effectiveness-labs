import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ArtifactError,
  AttemptStateSchema,
  AttemptStore,
  type AttemptProvenance,
} from '@ael/runtime';

describe('append-only attempts', () => {
  it('creates attempts without overwriting existing directories', async () => {
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-attempts-'));
    const store = new AttemptStore(experimentRoot);

    await store.createAttempt('trial-1', 'attempt-1', { schemaVersion: 1, status: 'running' });
    await expect(
      store.createAttempt('trial-1', 'attempt-1', { schemaVersion: 1, status: 'retry' }),
    ).rejects.toThrow(ArtifactError);

    const statePath = join(experimentRoot, 'attempts/trial-1/attempt-1/state.json');
    const state = AttemptStateSchema.parse(JSON.parse(readFileSync(statePath, 'utf8')));
    expect(state).toMatchObject({
      schemaVersion: 1,
      trialId: 'trial-1',
      attemptId: 'attempt-1',
      status: 'running',
    });
  });

  it('rejects attempt state that fails AttemptStateSchema', async () => {
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-attempts-'));
    const store = new AttemptStore(experimentRoot);

    await expect(
      store.createAttempt('trial-1', 'attempt-1', { status: 'running' }),
    ).rejects.toThrow(ArtifactError);
  });

  it('preserves unknown checkpoint fields through AttemptStateSchema passthrough', async () => {
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-attempts-'));
    const store = new AttemptStore(experimentRoot);

    await store.createAttempt('trial-1', 'attempt-1', {
      schemaVersion: 1,
      status: 'grading',
      workspaceRoot: '/tmp/ws',
      phaseIndex: 2,
    });

    const parsed = await store.readAttemptState('trial-1', 'attempt-1');
    expect(parsed).toMatchObject({
      status: 'grading',
      workspaceRoot: '/tmp/ws',
      phaseIndex: 2,
    });
  });

  it('lists attempt directories and reads validated state.json', async () => {
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-attempts-'));
    const store = new AttemptStore(experimentRoot);

    expect(await store.listAttemptIds('missing')).toEqual([]);

    await store.createAttempt('trial-1', 'attempt-b', { schemaVersion: 1, status: 'running' });
    await store.createAttempt('trial-1', 'attempt-a', { schemaVersion: 1, status: 'completed' });
    mkdirSync(join(experimentRoot, 'attempts/trial-1'), { recursive: true });
    writeFileSync(join(experimentRoot, 'attempts/trial-1', 'not-a-dir.json'), '{}', 'utf8');

    expect(await store.listAttemptIds('trial-1')).toEqual(['attempt-a', 'attempt-b']);
    expect((await store.readAttemptState('trial-1', 'attempt-a')).status).toBe('completed');
  });

  it('throws ArtifactError when state.json is missing or invalid', async () => {
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-attempts-'));
    const store = new AttemptStore(experimentRoot);
    const attemptDir = join(experimentRoot, 'attempts/trial-1/attempt-bad');
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(join(attemptDir, 'state.json'), '{not-json', 'utf8');

    await expect(store.readAttemptState('trial-1', 'attempt-bad')).rejects.toThrow(ArtifactError);
    await expect(store.readAttemptState('trial-1', 'missing')).rejects.toThrow(ArtifactError);
  });

  it('round-trips runner-owned provenance and returns null when it was never written', async () => {
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-attempts-'));
    const store = new AttemptStore(experimentRoot);
    const provenance: AttemptProvenance = {
      schemaVersion: 1,
      trialId: 'trial-1',
      attemptId: 'attempt-1',
      attemptIndex: 0,
      runnerVersion: '1.0.0',
      experimentFingerprint: 'exp',
      suiteFingerprint: 'suite',
      agentFingerprint: 'agent',
      isolationFingerprint: 'iso',
      pricingFingerprint: 'price',
      startedAt: '2026-01-01T00:00:00.000Z',
    };

    expect(await store.readAttemptProvenance('trial-1', 'attempt-1')).toBeNull();
    await store.writeAttemptProvenance(provenance);
    expect(await store.readAttemptProvenance('trial-1', 'attempt-1')).toEqual(provenance);
  });

  it('stores large blobs content-addressed under the attempt', async () => {
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-attempts-'));
    const store = new AttemptStore(experimentRoot);
    const payload = Buffer.from('large-blob-payload');

    const blobRef = await store.storeBlob('trial-1', 'attempt-1', payload);

    expect(blobRef.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(blobRef.path).equals(payload)).toBe(true);
  });
});
