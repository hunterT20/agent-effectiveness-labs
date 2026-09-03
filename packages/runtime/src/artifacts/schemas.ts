import { z } from 'zod';

export const PROTECTED_BLOB_ENVELOPE_VERSION = 1 as const;

export const StaleLockRecoverySchema = z
  .object({
    reason: z.string(),
    previousOwnerUuid: z.string(),
    recoveredAt: z.string(),
    recoveredByUuid: z.string(),
  })
  .strict();

export const LockRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    ownerUuid: z.string(),
    pid: z.number(),
    hostFingerprint: z.string(),
    heartbeatAt: z.string(),
    acquiredAt: z.string(),
    staleAfterMs: z.number(),
    staleRecoveries: z.array(StaleLockRecoverySchema),
  })
  .strict();

export const AttemptStateSchema = z.unknown();

export const ProtectedBlobEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(PROTECTED_BLOB_ENVELOPE_VERSION),
    algorithm: z.literal('aes-256-gcm'),
    iv: z.string(),
    authTag: z.string(),
    plaintextSha256: z.string(),
  })
  .strict();
