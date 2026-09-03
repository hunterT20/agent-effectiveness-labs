import { describe, expect, it } from 'vitest';

import {
  buildResumeFingerprints,
  evaluateResume,
  RESUME_ERROR_CODES,
  RUNNER_VERSION,
} from '../../src/runner/resume.js';

describe('strict resume', () => {
  const base = buildResumeFingerprints({
    suiteFingerprint: 'suite-a',
    agentFingerprint: 'agent-a',
    isolationFingerprint: 'iso-a',
    pricingFingerprint: 'price-a',
  });

  it('blocks resume on fingerprint mismatch with CONFIG_DRIFT', () => {
    const current = buildResumeFingerprints({
      suiteFingerprint: 'suite-b',
      agentFingerprint: 'agent-a',
      isolationFingerprint: 'iso-a',
      pricingFingerprint: 'price-a',
    });
    const decision = evaluateResume({
      stored: base,
      current,
      attemptStatus: 'grading',
      attemptIndex: 0,
      maxInfraRetries: 2,
      infraFailureCount: 0,
    });
    expect(decision.action).toBe('config_drift');
    expect(decision.reason).toBe(RESUME_ERROR_CODES.CONFIG_DRIFT);
  });

  it('blocks resume on runner version mismatch', () => {
    const stored = { ...base, runnerVersion: '0.9.0' };
    const decision = evaluateResume({
      stored,
      current: base,
      attemptStatus: 'grading',
      attemptIndex: 0,
      maxInfraRetries: 2,
      infraFailureCount: 0,
    });
    expect(decision.action).toBe('config_drift');
  });

  it('resumes grading without rerunning agent', () => {
    const decision = evaluateResume({
      stored: base,
      current: base,
      attemptStatus: 'grading',
      attemptIndex: 0,
      maxInfraRetries: 2,
      infraFailureCount: 0,
    });
    expect(decision.action).toBe('resume');
  });

  it('creates new attempt for unknown running state', () => {
    const decision = evaluateResume({
      stored: base,
      current: base,
      attemptStatus: 'running',
      attemptIndex: 0,
      maxInfraRetries: 2,
      infraFailureCount: 0,
    });
    expect(decision.action).toBe('new_attempt');
    expect(decision.attemptIndex).toBe(1);
  });

  it('does not auto-retry agent failure', () => {
    const decision = evaluateResume({
      stored: base,
      current: base,
      attemptStatus: 'agent_failed',
      attemptIndex: 0,
      maxInfraRetries: 2,
      infraFailureCount: 0,
    });
    expect(decision.action).toBe('skip');
  });

  it('records runner version in fingerprints', () => {
    expect(base.runnerVersion).toBe(RUNNER_VERSION);
  });
});
