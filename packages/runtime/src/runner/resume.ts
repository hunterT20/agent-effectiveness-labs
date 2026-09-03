export const RUNNER_VERSION = '1.0.0';

export const RESUME_ERROR_CODES = {
  CONFIG_DRIFT: 'CONFIG_DRIFT',
  INFRA_RETRY_EXHAUSTED: 'INFRA_RETRY_EXHAUSTED',
} as const;

export type ResumeErrorCode = (typeof RESUME_ERROR_CODES)[keyof typeof RESUME_ERROR_CODES];

export interface ResumeFingerprints {
  readonly suiteFingerprint: string;
  readonly agentFingerprint: string;
  readonly isolationFingerprint: string;
  readonly pricingFingerprint: string;
  readonly runnerVersion: string;
}

export type ResumeAction = 'resume' | 'new_attempt' | 'skip' | 'config_drift';

export interface ResumeDecision {
  readonly action: ResumeAction;
  readonly reason: string | null;
  readonly attemptIndex: number;
}

export interface EvaluateResumeInput {
  readonly stored: ResumeFingerprints;
  readonly current: ResumeFingerprints;
  readonly attemptStatus: string;
  readonly attemptIndex: number;
  readonly maxInfraRetries: number;
  readonly infraFailureCount: number;
}

function fingerprintsMatch(stored: ResumeFingerprints, current: ResumeFingerprints): boolean {
  return (
    stored.suiteFingerprint === current.suiteFingerprint &&
    stored.agentFingerprint === current.agentFingerprint &&
    stored.isolationFingerprint === current.isolationFingerprint &&
    stored.pricingFingerprint === current.pricingFingerprint &&
    stored.runnerVersion === current.runnerVersion
  );
}

export function evaluateResume(input: EvaluateResumeInput): ResumeDecision {
  if (!fingerprintsMatch(input.stored, input.current)) {
    return {
      action: 'config_drift',
      reason: RESUME_ERROR_CODES.CONFIG_DRIFT,
      attemptIndex: input.attemptIndex,
    };
  }

  if (input.attemptStatus === 'completed') {
    return { action: 'skip', reason: 'already completed', attemptIndex: input.attemptIndex };
  }

  if (
    input.attemptStatus === 'running' ||
    input.attemptStatus === 'preparing' ||
    input.attemptStatus === 'pending'
  ) {
    if (input.infraFailureCount >= input.maxInfraRetries) {
      return {
        action: 'config_drift',
        reason: RESUME_ERROR_CODES.INFRA_RETRY_EXHAUSTED,
        attemptIndex: input.attemptIndex,
      };
    }
    return {
      action: 'new_attempt',
      reason: 'unknown process state',
      attemptIndex: input.attemptIndex + 1,
    };
  }

  if (input.attemptStatus === 'grading' || input.attemptStatus === 'collecting') {
    return { action: 'resume', reason: null, attemptIndex: input.attemptIndex };
  }

  if (
    input.attemptStatus === 'agent_failed' ||
    input.attemptStatus === 'timed_out' ||
    input.attemptStatus === 'infrastructure_failed'
  ) {
    return {
      action: 'skip',
      reason: 'terminal agent failure without auto-retry',
      attemptIndex: input.attemptIndex,
    };
  }

  return { action: 'resume', reason: null, attemptIndex: input.attemptIndex };
}

export function buildResumeFingerprints(input: {
  suiteFingerprint: string;
  agentFingerprint: string;
  isolationFingerprint: string;
  pricingFingerprint: string;
}): ResumeFingerprints {
  return {
    suiteFingerprint: input.suiteFingerprint,
    agentFingerprint: input.agentFingerprint,
    isolationFingerprint: input.isolationFingerprint,
    pricingFingerprint: input.pricingFingerprint,
    runnerVersion: RUNNER_VERSION,
  };
}
