import { randomUUID } from 'node:crypto';
import { access, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ARTIFACT_ERROR_CODES, ArtifactError } from './errors.js';
import { readAtomicJson, writeAtomicJson } from './atomicWrite.js';
import { computeHostFingerprint } from './host.js';
import { LockRecordSchema } from './schemas.js';

export interface StaleLockRecovery {
  readonly reason: string;
  readonly previousOwnerUuid: string;
  readonly recoveredAt: string;
  readonly recoveredByUuid: string;
}

export interface LockRecord {
  readonly schemaVersion: 1;
  readonly ownerUuid: string;
  readonly pid: number;
  readonly hostFingerprint: string;
  readonly heartbeatAt: string;
  readonly acquiredAt: string;
  readonly staleAfterMs: number;
  readonly staleRecoveries: readonly StaleLockRecovery[];
}

export interface ExperimentLockOptions {
  readonly ownerUuid?: string;
  readonly pid?: number;
  readonly hostFingerprint?: string;
  readonly heartbeatIntervalMs?: number;
  readonly staleAfterMs?: number;
}

export class ExperimentLock {
  private readonly ownerUuid: string;
  private readonly pid: number;
  private readonly hostFingerprint: string;
  private readonly staleAfterMs: number;

  constructor(
    private readonly lockPath: string,
    options: ExperimentLockOptions = {},
  ) {
    this.ownerUuid = options.ownerUuid ?? randomUUID();
    this.pid = options.pid ?? process.pid;
    this.hostFingerprint = options.hostFingerprint ?? computeHostFingerprint();
    this.staleAfterMs = options.staleAfterMs ?? 30_000;
  }

  async acquire(options?: { staleRecovery?: StaleLockRecovery }): Promise<void> {
    const existing = await this.tryRead();

    if (existing !== null) {
      const sameOwner = existing.ownerUuid === this.ownerUuid && existing.pid === this.pid;
      if (sameOwner) {
        await this.writeRecord({
          ...existing,
          heartbeatAt: new Date().toISOString(),
        });
        return;
      }

      if (!this.isRecordStale(existing)) {
        throw new ArtifactError(
          ARTIFACT_ERROR_CODES.LOCK_HELD,
          `Experiment lock is held by ${existing.ownerUuid}`,
        );
      }

      if (options?.staleRecovery === undefined) {
        throw new ArtifactError(
          ARTIFACT_ERROR_CODES.STALE_LOCK_RECOVERY_REQUIRED,
          'Stale experiment lock requires explicit recovery metadata',
        );
      }

      const stalePath = join(dirname(this.lockPath), `lock.stale.${String(Date.now())}.json`);
      await rename(this.lockPath, stalePath);

      const record = this.buildRecord([...existing.staleRecoveries, options.staleRecovery]);
      await this.createExclusive(record);
      return;
    }

    const record = this.buildRecord([]);
    await this.createExclusive(record);
  }

  async heartbeat(): Promise<void> {
    const existing = await this.tryRead();
    if (existing === null || existing.ownerUuid !== this.ownerUuid || existing.pid !== this.pid) {
      throw new ArtifactError(
        ARTIFACT_ERROR_CODES.LOCK_HELD,
        'Cannot heartbeat without holding the experiment lock',
      );
    }

    await this.writeRecord({
      ...existing,
      heartbeatAt: new Date().toISOString(),
    });
  }

  async release(): Promise<void> {
    const existing = await this.tryRead();
    if (existing === null) {
      return;
    }

    if (existing.ownerUuid !== this.ownerUuid || existing.pid !== this.pid) {
      throw new ArtifactError(
        ARTIFACT_ERROR_CODES.LOCK_HELD,
        'Cannot release a lock owned by another writer',
      );
    }

    await unlink(this.lockPath);
  }

  async read(): Promise<LockRecord | null> {
    return this.tryRead();
  }

  private buildRecord(staleRecoveries: readonly StaleLockRecovery[]): LockRecord {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      ownerUuid: this.ownerUuid,
      pid: this.pid,
      hostFingerprint: this.hostFingerprint,
      heartbeatAt: now,
      acquiredAt: now,
      staleAfterMs: this.staleAfterMs,
      staleRecoveries,
    };
  }

  private async createExclusive(record: LockRecord): Promise<void> {
    const payload = `${JSON.stringify(record, null, 2)}\n`;

    try {
      const handle = await open(this.lockPath, 'wx');
      try {
        await handle.writeFile(payload, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        const current = await this.tryRead();
        if (current !== null) {
          const sameOwner = current.ownerUuid === this.ownerUuid && current.pid === this.pid;
          if (sameOwner) {
            await this.writeRecord({
              ...current,
              heartbeatAt: new Date().toISOString(),
            });
            return;
          }

          throw new ArtifactError(
            ARTIFACT_ERROR_CODES.LOCK_HELD,
            `Experiment lock is held by ${current.ownerUuid}`,
          );
        }
      }

      throw error;
    }
  }

  private async writeRecord(record: LockRecord): Promise<void> {
    await writeAtomicJson(this.lockPath, record);
  }

  private async tryRead(): Promise<LockRecord | null> {
    try {
      await access(this.lockPath);
    } catch {
      return null;
    }

    try {
      const parsed = await readAtomicJson(this.lockPath, LockRecordSchema);
      return {
        ...parsed,
        staleRecoveries: parsed.staleRecoveries,
      };
    } catch {
      return null;
    }
  }

  private isRecordStale(record: LockRecord): boolean {
    const heartbeatMs = Date.parse(record.heartbeatAt);
    if (Number.isNaN(heartbeatMs)) {
      return true;
    }
    return Date.now() - heartbeatMs > record.staleAfterMs;
  }
}
