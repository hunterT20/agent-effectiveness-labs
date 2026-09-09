import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  buildResumeFingerprints,
  evaluateResume,
  findFingerprintDrift,
  isAbandonedAttemptStatus,
  isInfrastructureIncidentStatus,
  RESUME_ERROR_CODES,
  RUNNER_VERSION,
  type ResumeFingerprints,
} from '../../src/runner/resume.js';

const RuntimePackageJsonSchema = z.object({ version: z.string().min(1) }).passthrough();

describe('strict resume', () => {
  const base = buildResumeFingerprints({
    suiteFingerprint: 'suite-a',
    agentFingerprint: 'agent-a',
    isolationFingerprint: 'iso-a',
    pricingFingerprint: 'price-a',
  });

  function decide(
    overrides: Partial<{
      stored: Partial<ResumeFingerprints>;
      current: ResumeFingerprints;
      attemptStatus: string;
      attemptIndex: number;
      maxInfraRetries: number;
      infraFailureCount: number;
    }>,
  ) {
    return evaluateResume({
      stored: overrides.stored ?? base,
      current: overrides.current ?? base,
      attemptStatus: overrides.attemptStatus ?? 'grading',
      attemptIndex: overrides.attemptIndex ?? 0,
      maxInfraRetries: overrides.maxInfraRetries ?? 2,
      infraFailureCount: overrides.infraFailureCount ?? 0,
    });
  }

  it('reads RUNNER_VERSION from the runtime package.json', () => {
    const loaded: unknown = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    );
    expect(RUNNER_VERSION).toBe(RuntimePackageJsonSchema.parse(loaded).version);
    expect(base.runnerVersion).toBe(RUNNER_VERSION);
    expect(base.experimentFingerprint).toBe('suite-a');
  });

  it('blocks resume on fingerprint mismatch with CONFIG_DRIFT', () => {
    const current = buildResumeFingerprints({
      experimentFingerprint: 'suite-a',
      suiteFingerprint: 'suite-b',
      agentFingerprint: 'agent-a',
      isolationFingerprint: 'iso-a',
      pricingFingerprint: 'price-a',
    });
    const decision = decide({ current });
    expect(decision.action).toBe('config_drift');
    expect(decision.reason).toBe(`${RESUME_ERROR_CODES.CONFIG_DRIFT}: suiteFingerprint`);
    expect(findFingerprintDrift(base, current)).toEqual({
      code: RESUME_ERROR_CODES.CONFIG_DRIFT,
      fields: ['suiteFingerprint'],
    });
  });

  it('blocks resume on runner version mismatch', () => {
    const stored = { ...base, runnerVersion: '0.9.0' };
    const decision = decide({ stored });
    expect(decision.action).toBe('config_drift');
    expect(decision.reason).toBe(`${RESUME_ERROR_CODES.CONFIG_DRIFT}: runnerVersion`);
  });

  it('treats a missing stored fingerprint as unknown provenance drift', () => {
    const { suiteFingerprint: _omitted, ...stored } = base;
    const decision = decide({ stored });
    expect(decision.action).toBe('config_drift');
    expect(decision.reason).toBe(`${RESUME_ERROR_CODES.UNKNOWN_PROVENANCE}: suiteFingerprint`);
  });

  it('resumes grading and collecting without rerunning the agent', () => {
    expect(decide({ attemptStatus: 'grading' }).action).toBe('resume');
    expect(decide({ attemptStatus: 'collecting' })).toEqual({
      action: 'resume',
      reason: null,
      attemptIndex: 0,
    });
  });

  it('creates a new attempt for preparing, running, and other unknown process state', () => {
    for (const status of ['pending', 'preparing', 'running']) {
      const decision = decide({ attemptStatus: status, attemptIndex: 0, infraFailureCount: 1 });
      expect(decision.action).toBe('new_attempt');
      expect(decision.attemptIndex).toBe(1);
      expect(isAbandonedAttemptStatus(status)).toBe(true);
      expect(isInfrastructureIncidentStatus(status)).toBe(true);
    }
  });

  it('retries infrastructure failure while the count is within maxInfraRetries', () => {
    const decision = decide({
      attemptStatus: 'infrastructure_failed',
      attemptIndex: 1,
      maxInfraRetries: 2,
      infraFailureCount: 2,
    });
    expect(decision.action).toBe('new_attempt');
    expect(decision.attemptIndex).toBe(2);
    expect(decision.reason).toBe('infrastructure failure retry');
  });

  it('reports INFRA_RETRY_EXHAUSTED instead of config drift when the budget is spent', () => {
    const decision = decide({
      attemptStatus: 'infrastructure_failed',
      attemptIndex: 2,
      maxInfraRetries: 2,
      infraFailureCount: 3,
    });
    expect(decision.action).toBe('infra_retry_exhausted');
    expect(decision.reason).toBe(RESUME_ERROR_CODES.INFRA_RETRY_EXHAUSTED);
  });

  it('does not auto-retry agent failure or timeout', () => {
    expect(decide({ attemptStatus: 'agent_failed' }).action).toBe('skip');
    expect(decide({ attemptStatus: 'timed_out' }).action).toBe('skip');
  });

  it('starts a new attempt after operator cancellation without consuming the infra budget', () => {
    const decision = decide({
      attemptStatus: 'cancelled',
      attemptIndex: 0,
      maxInfraRetries: 0,
      infraFailureCount: 99,
    });
    expect(decision.action).toBe('new_attempt');
    expect(decision.attemptIndex).toBe(1);
    expect(isInfrastructureIncidentStatus('cancelled')).toBe(false);
  });

  it('skips an already completed attempt', () => {
    expect(decide({ attemptStatus: 'completed' })).toEqual({
      action: 'skip',
      reason: 'already completed',
      attemptIndex: 0,
    });
  });
});
