import { createRequire } from 'node:module';

import { z } from 'zod';

const RuntimePackageJsonSchema = z.object({ version: z.string().min(1) }).passthrough();

function readRuntimeVersion(): string {
  // Resolves to packages/runtime/package.json from both src/runner and dist/runner.
  const requireFromRuntime = createRequire(import.meta.url);
  const loaded: unknown = requireFromRuntime('../../package.json');
  return RuntimePackageJsonSchema.parse(loaded).version;
}

/** Version of the runtime package; persisted per attempt and compared on resume. */
export const RUNNER_VERSION: string = readRuntimeVersion();

export const RESUME_ERROR_CODES = {
  CONFIG_DRIFT: 'CONFIG_DRIFT',
  UNKNOWN_PROVENANCE: 'UNKNOWN_PROVENANCE',
  INFRA_RETRY_EXHAUSTED: 'INFRA_RETRY_EXHAUSTED',
} as const;

export type ResumeErrorCode = (typeof RESUME_ERROR_CODES)[keyof typeof RESUME_ERROR_CODES];

export interface ResumeFingerprints {
  readonly experimentFingerprint: string;
  readonly suiteFingerprint: string;
  readonly agentFingerprint: string;
  readonly isolationFingerprint: string;
  readonly pricingFingerprint: string;
  readonly runnerVersion: string;
}

/** Fingerprints read back from disk; any missing field means provenance is unknown. */
export type StoredResumeFingerprints = Partial<ResumeFingerprints>;

export type ResumeAction =
  'resume' | 'new_attempt' | 'skip' | 'config_drift' | 'infra_retry_exhausted';

export interface ResumeDecision {
  readonly action: ResumeAction;
  readonly reason: string | null;
  /** Attempt index to operate on: the stored one for resume/skip, the next one for new attempts. */
  readonly attemptIndex: number;
}

export interface EvaluateResumeInput {
  readonly stored: StoredResumeFingerprints;
  readonly current: ResumeFingerprints;
  /** Status of the latest attempt of the trial. */
  readonly attemptStatus: string;
  /** Index of the latest attempt of the trial. */
  readonly attemptIndex: number;
  readonly maxInfraRetries: number;
  /**
   * Number of infrastructure incidents recorded across ALL attempts of the trial (including the
   * latest): `infrastructure_failed` attempts plus attempts abandoned mid-flight.
   */
  readonly infraFailureCount: number;
}

const FINGERPRINT_KEYS: ReadonlyArray<keyof ResumeFingerprints> = [
  'experimentFingerprint',
  'suiteFingerprint',
  'agentFingerprint',
  'isolationFingerprint',
  'pricingFingerprint',
  'runnerVersion',
];

/** Statuses that can be resumed from their last checkpoint without rerunning the agent. */
const CHECKPOINT_RESUMABLE_STATUSES: ReadonlySet<string> = new Set(['collecting', 'grading']);

/** Terminal agent outcomes that must never be retried automatically. */
const AGENT_TERMINAL_STATUSES: ReadonlySet<string> = new Set(['agent_failed', 'timed_out']);

/**
 * Attempts whose process disappeared before reaching a checkpoint-resumable state. The workspace
 * state is unknown, so they always require a fresh attempt.
 */
export function isAbandonedAttemptStatus(status: string): boolean {
  return (
    status !== 'completed' &&
    status !== 'infrastructure_failed' &&
    status !== 'cancelled' &&
    !CHECKPOINT_RESUMABLE_STATUSES.has(status) &&
    !AGENT_TERMINAL_STATUSES.has(status)
  );
}

/** Whether an attempt status counts as an infrastructure incident for the retry budget. */
export function isInfrastructureIncidentStatus(status: string): boolean {
  return status === 'infrastructure_failed' || isAbandonedAttemptStatus(status);
}

export function findFingerprintDrift(
  stored: StoredResumeFingerprints,
  current: ResumeFingerprints,
): { readonly code: ResumeErrorCode; readonly fields: readonly string[] } | null {
  const missing = FINGERPRINT_KEYS.filter((key) => stored[key] === undefined);
  if (missing.length > 0) {
    return { code: RESUME_ERROR_CODES.UNKNOWN_PROVENANCE, fields: missing };
  }
  const changed = FINGERPRINT_KEYS.filter((key) => stored[key] !== current[key]);
  if (changed.length > 0) {
    return { code: RESUME_ERROR_CODES.CONFIG_DRIFT, fields: changed };
  }
  return null;
}

export function evaluateResume(input: EvaluateResumeInput): ResumeDecision {
  const drift = findFingerprintDrift(input.stored, input.current);
  if (drift !== null) {
    return {
      action: 'config_drift',
      reason: `${drift.code}: ${drift.fields.join(', ')}`,
      attemptIndex: input.attemptIndex,
    };
  }

  const status = input.attemptStatus;

  if (status === 'completed') {
    return { action: 'skip', reason: 'already completed', attemptIndex: input.attemptIndex };
  }

  if (AGENT_TERMINAL_STATUSES.has(status)) {
    return {
      action: 'skip',
      reason: 'terminal agent failure without auto-retry',
      attemptIndex: input.attemptIndex,
    };
  }

  if (CHECKPOINT_RESUMABLE_STATUSES.has(status)) {
    return { action: 'resume', reason: null, attemptIndex: input.attemptIndex };
  }

  if (status === 'cancelled') {
    // Operator interruption is not an infrastructure incident; it never consumes retry budget.
    return {
      action: 'new_attempt',
      reason: 'previous attempt cancelled by operator',
      attemptIndex: input.attemptIndex + 1,
    };
  }

  // infrastructure_failed or abandoned mid-flight: retry within the infrastructure budget.
  if (input.infraFailureCount > input.maxInfraRetries) {
    return {
      action: 'infra_retry_exhausted',
      reason: RESUME_ERROR_CODES.INFRA_RETRY_EXHAUSTED,
      attemptIndex: input.attemptIndex,
    };
  }
  return {
    action: 'new_attempt',
    reason:
      status === 'infrastructure_failed' ? 'infrastructure failure retry' : 'unknown process state',
    attemptIndex: input.attemptIndex + 1,
  };
}

export function buildResumeFingerprints(input: {
  experimentFingerprint?: string;
  suiteFingerprint: string;
  agentFingerprint: string;
  isolationFingerprint: string;
  pricingFingerprint: string;
  runnerVersion?: string;
}): ResumeFingerprints {
  return {
    experimentFingerprint: input.experimentFingerprint ?? input.suiteFingerprint,
    suiteFingerprint: input.suiteFingerprint,
    agentFingerprint: input.agentFingerprint,
    isolationFingerprint: input.isolationFingerprint,
    pricingFingerprint: input.pricingFingerprint,
    runnerVersion: input.runnerVersion ?? RUNNER_VERSION,
  };
}
