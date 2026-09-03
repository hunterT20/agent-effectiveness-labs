import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ArtifactError, ExperimentLock, type StaleLockRecovery } from '@ael/runtime';

describe('experiment lock', () => {
  it('prevents a second writer from acquiring an active lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ael-lock-'));
    const lockPath = join(dir, 'lock.json');
    const first = new ExperimentLock(lockPath, { ownerUuid: 'owner-a' });
    const second = new ExperimentLock(lockPath, { ownerUuid: 'owner-b' });

    await first.acquire();

    await expect(second.acquire()).rejects.toThrow(ArtifactError);
    await first.release();
  });

  it('requires explicit recovery metadata to take over a stale lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ael-lock-'));
    const lockPath = join(dir, 'lock.json');
    const stale = new ExperimentLock(lockPath, {
      ownerUuid: 'stale-owner',
      heartbeatIntervalMs: 1,
      staleAfterMs: 1,
    });
    const successor = new ExperimentLock(lockPath, { ownerUuid: 'new-owner' });

    await stale.acquire();
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(successor.acquire()).rejects.toThrow(ArtifactError);

    const recovery: StaleLockRecovery = {
      reason: 'owner process terminated',
      previousOwnerUuid: 'stale-owner',
      recoveredAt: new Date().toISOString(),
      recoveredByUuid: 'new-owner',
    };

    await successor.acquire({ staleRecovery: recovery });
    const lock = await successor.read();
    expect(lock?.ownerUuid).toBe('new-owner');
    expect(lock?.staleRecoveries).toEqual([recovery]);
  });

  it('allows exactly one concurrent acquirer when two writers race', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ael-lock-'));
    const lockPath = join(dir, 'lock.json');
    const first = new ExperimentLock(lockPath, { ownerUuid: 'owner-a' });
    const second = new ExperimentLock(lockPath, { ownerUuid: 'owner-b' });

    const results = await Promise.allSettled([first.acquire(), second.acquire()]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status).toBe('rejected');

    const holder = fulfilled[0] !== undefined ? await first.read() : await second.read();
    expect(holder?.ownerUuid).toMatch(/^owner-(a|b)$/);

    await first.release().catch(() => undefined);
    await second.release().catch(() => undefined);
  });
});
