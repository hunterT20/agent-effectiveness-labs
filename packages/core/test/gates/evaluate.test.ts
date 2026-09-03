import { describe, expect, it } from 'vitest';

import { deriveVerdict, evaluateGates } from '@ael/core';

const decisionPolicy = {
  mode: 'preregistered' as const,
  minimumCompletedPairs: 2,
  minimumIndependentFixtures: 1,
  maximumInfrastructureFailureRate: 0.05,
  verifiedSuccessDeltaMin: 0.1,
  pairedImprovementPValueMax: 0.5,
  multipleComparisonMethod: 'holm' as const,
  treatmentCriticalSafetyMax: 0,
  treatmentStaleEvidenceAcceptedMax: 0,
  treatmentRecoveryRateMin: 0.9,
  treatmentFalseBlockRateMax: 0.05,
  telemetryCoverageMin: 0.9,
  treatmentToControlCostPerSuccessMaxRatio: 1.1,
  treatmentToControlMedianDurationMaxRatio: 1.2,
  treatmentToControlMedianTokensMaxRatio: 1.2,
};

const baseStatistics = {
  independentFixtureCount: 2,
  trialCount: 4,
  pairedSignTest: {
    improvements: 2,
    regressions: 0,
    ties: 0,
    pValueOneSided: 0.25,
    pValueTwoSided: 0.5,
  },
  verifiedSuccessDelta: 0.5,
  controlVerifiedSuccessRate: 0,
  treatmentVerifiedSuccessRate: 0.5,
  controlMedianDurationMs: 100,
  treatmentMedianDurationMs: 120,
  controlP90DurationMs: 100,
  treatmentP90DurationMs: 120,
  controlP95DurationMs: 100,
  treatmentP95DurationMs: 120,
  infrastructureFailureRate: 0,
};

describe('decision gates', () => {
  it('returns FAILED when any gate fails', () => {
    const gates = evaluateGates({
      decisionPolicy,
      decisionPolicyMode: 'preregistered',
      statistics: { ...baseStatistics, verifiedSuccessDelta: 0.01 },
      completedPairs: 2,
      evidenceRoot: '/tmp/evidence',
    });
    expect(deriveVerdict(gates)).toBe('FAILED');
  });

  it('returns INSUFFICIENT_DATA when evidence is missing but no gate failed', () => {
    const gates = evaluateGates({
      decisionPolicy,
      decisionPolicyMode: 'preregistered',
      statistics: { ...baseStatistics, independentFixtureCount: 0 },
      completedPairs: 0,
      evidenceRoot: '/tmp/evidence',
    });
    expect(deriveVerdict(gates)).toBe('INSUFFICIENT_DATA');
  });

  it('returns PASSED when all required gates pass', () => {
    const gates = evaluateGates({
      decisionPolicy,
      decisionPolicyMode: 'preregistered',
      statistics: baseStatistics,
      completedPairs: 2,
      evidenceRoot: '/tmp/evidence',
    });
    expect(deriveVerdict(gates)).toBe('PASSED');
  });

  it('skips significance gates in exploratory mode', () => {
    const gates = evaluateGates({
      decisionPolicy,
      decisionPolicyMode: 'exploratory',
      statistics: { ...baseStatistics, verifiedSuccessDelta: -1 },
      completedPairs: 0,
      evidenceRoot: '/tmp/evidence',
    });
    expect(gates.some((entry) => entry.id === 'verified-success-delta')).toBe(false);
  });
});
