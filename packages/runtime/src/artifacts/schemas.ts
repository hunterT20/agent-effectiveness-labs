import { z } from 'zod';

import { TrialPlanEntrySchema } from '@ael/core';

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

/**
 * Persisted `attempts/<trialId>/<attemptId>/state.json`.
 *
 * Both the trial runner (checkpoints) and the experiment runner (provenance) write this file, so
 * only the identity fields are required. Resume provenance fields are optional for backward
 * compatibility with attempts written before they were recorded; `.passthrough()` keeps unknown
 * checkpoint fields (workspaceRoot, phaseIndex, ...) intact for forward compatibility.
 */
export const AttemptStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    trialId: z.string(),
    attemptId: z.string(),
    status: z.string(),
    attemptIndex: z.number().int().nonnegative().optional(),
    runnerVersion: z.string().optional(),
    experimentFingerprint: z.string().optional(),
    suiteFingerprint: z.string().optional(),
    agentFingerprint: z.string().optional(),
    isolationFingerprint: z.string().optional(),
    pricingFingerprint: z.string().optional(),
    planEntry: TrialPlanEntrySchema.optional(),
    durationMs: z.number().finite().nullable().optional(),
    startedAt: z.string().min(1).optional(),
    endedAt: z.string().min(1).optional(),
  })
  .passthrough();

export type AttemptState = z.infer<typeof AttemptStateSchema>;

/**
 * Runner-owned `attempts/<trialId>/<attemptId>/provenance.json`, written before a trial starts so
 * resume can detect config drift even when the trial runner later overwrites `state.json`.
 */
export const AttemptProvenanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    trialId: z.string(),
    attemptId: z.string(),
    attemptIndex: z.number().int().nonnegative(),
    runnerVersion: z.string(),
    experimentFingerprint: z.string(),
    suiteFingerprint: z.string(),
    agentFingerprint: z.string(),
    isolationFingerprint: z.string(),
    pricingFingerprint: z.string(),
    startedAt: z.string(),
  })
  .passthrough();

export type AttemptProvenance = z.infer<typeof AttemptProvenanceSchema>;

export const ProtectedBlobEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(PROTECTED_BLOB_ENVELOPE_VERSION),
    algorithm: z.literal('aes-256-gcm'),
    iv: z.string(),
    authTag: z.string(),
    plaintextSha256: z.string(),
  })
  .strict();
