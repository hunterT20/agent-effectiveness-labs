import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ArtifactError, AttemptStore } from '@ael/runtime';

describe('append-only attempts', () => {
  it('creates attempts without overwriting existing directories', async () => {
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-attempts-'));
    const store = new AttemptStore(experimentRoot);

    await store.createAttempt('trial-1', 'attempt-1', { schemaVersion: 1, status: 'running' });
    await expect(
      store.createAttempt('trial-1', 'attempt-1', { schemaVersion: 1, status: 'retry' }),
    ).rejects.toThrow(ArtifactError);

    const statePath = join(experimentRoot, 'attempts/trial-1/attempt-1/state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { status: string };
    expect(state.status).toBe('running');
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
