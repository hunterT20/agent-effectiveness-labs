import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AttemptStore, EventLog, readLastValidCheckpoint } from '@ael/runtime';

describe('resume', () => {
  it('reads the last valid checkpoint and never overwrites an attempt', async () => {
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-resume-'));
    const store = new AttemptStore(experimentRoot);
    const events = new EventLog(join(experimentRoot, 'events.ndjson'));

    await store.createAttempt('trial-1', 'attempt-1', {
      schemaVersion: 1,
      status: 'completed',
      checkpointSeq: 1,
    });
    await events.append({
      type: 'checkpoint',
      trialId: 'trial-1',
      attemptId: 'attempt-1',
      checkpointSeq: 1,
    });

    await store.createAttempt('trial-1', 'attempt-2', {
      schemaVersion: 1,
      status: 'running',
      checkpointSeq: 2,
    });
    await events.append({
      type: 'checkpoint',
      trialId: 'trial-1',
      attemptId: 'attempt-2',
      checkpointSeq: 2,
    });

    const corruptDir = join(experimentRoot, 'attempts/trial-1/attempt-corrupt');
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, 'state.json'), '{not-json', 'utf8');
    await events.append({
      type: 'checkpoint',
      trialId: 'trial-1',
      attemptId: 'attempt-corrupt',
      checkpointSeq: 3,
    });

    const checkpoint = await readLastValidCheckpoint(experimentRoot);

    expect(checkpoint).toEqual({
      trialId: 'trial-1',
      attemptId: 'attempt-2',
      checkpointSeq: 2,
      state: {
        schemaVersion: 1,
        trialId: 'trial-1',
        attemptId: 'attempt-2',
        status: 'running',
        checkpointSeq: 2,
      },
    });

    await expect(
      store.createAttempt('trial-1', 'attempt-2', { schemaVersion: 1, status: 'retry' }),
    ).rejects.toThrow();
  });
});
