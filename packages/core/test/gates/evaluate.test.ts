import { describe, expect, it } from 'vitest';

import {
  computeExperimentStatistics,
  deriveVerdict,
  evaluateGates,
  requiredCapabilityNames,
  unmetRequiredCapabilities,
  type ExperimentStatistics,
  type TrialMetricInput,
} from '@ael/core';

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

function trial(
  fixtureId: string,
  armId: string,
  verifiedSuccess: boolean,
  overrides: Partial<TrialMetricInput> = {},
): TrialMetricInput {
  return {
    fixtureId,
    armId,
    repeatIndex: 0,
    status: 'completed',
    verifiedSuccess,
    infrastructureFailed: false,
    durationMs: 100,
    safetyViolation: false,
    ...overrides,
  };
}

/** Two fixtures, both improvements → completedPairs 2, delta 1, p = 0.25. */
const computedStatistics = computeExperimentStatistics({
  controlArm: 'control',
  treatmentArm: 'treatment',
  trials: [
    trial('f1', 'control', false),
    trial('f1', 'treatment', true),
    trial('f2', 'control', false),
    trial('f2', 'treatment', true),
  ],
  randomSeed: 'seed',
  bootstrapIterations: 50,
  minimumDiscordantPairs: 1,
});

/** Gate tests treat power as an input: pretend the tiny experiment is adequately powered. */
const baseStatistics: ExperimentStatistics = {
  ...computedStatistics,
  powerReadiness: {
    ...computedStatistics.powerReadiness,
    lowPower: false,
    reasons: [],
    fixtureWarning: null,
  },
};

function gateById(gates: ReturnType<typeof evaluateGates>, id: string) {
  const found = gates.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`gate ${id} missing`);
  }
  return found;
}

describe('decision gates', () => {
  it('returns FAILED when any gate fails', () => {
    const gates = evaluateGates({
      decisionPolicy,
      decisionPolicyMode: 'preregistered',
      statistics: { ...baseStatistics, verifiedSuccessDelta: 0.01 },
      completedPairs: 2,
      evidenceRoot: 'attempts',
    });
    expect(deriveVerdict(gates)).toBe('FAILED');
  });

  it('returns INSUFFICIENT_DATA when evidence is missing but no gate failed', () => {
    const gates = evaluateGates({
      decisionPolicy,
      decisionPolicyMode: 'preregistered',
      statistics: { ...baseStatistics, independentFixtureCount: 0 },
      completedPairs: 0,
      evidenceRoot: 'attempts',
    });
    expect(deriveVerdict(gates)).toBe('INSUFFICIENT_DATA');
  });

  it('returns PASSED when all required gates pass', () => {
    const gates = evaluateGates({
      decisionPolicy,
      decisionPolicyMode: 'preregistered',
      statistics: baseStatistics,
      completedPairs: 2,
      evidenceRoot: 'attempts',
    });
    expect(deriveVerdict(gates)).toBe('PASSED');
    expect(gateById(gates, 'CAPABILITY_REQUIREMENTS').status).toBe('not_evaluated');
    expect(gateById(gates, 'BLINDED_AGREEMENT').status).toBe('not_evaluated');
    expect(gateById(gates, 'LOW_POWER').status).toBe('passed');
    for (const gate of gates) {
      expect(Array.isArray(gate.evidencePaths)).toBe(true);
    }
  });

  it('skips significance gates in exploratory mode', () => {
    const gates = evaluateGates({
      decisionPolicy,
      decisionPolicyMode: 'exploratory',
      statistics: { ...baseStatistics, verifiedSuccessDelta: -1 },
      completedPairs: 0,
      evidenceRoot: 'attempts',
    });
    expect(gates.some((entry) => entry.id === 'verified-success-delta')).toBe(false);
  });

  it('carries evidence paths on statistical gates', () => {
    const gates = evaluateGates({
      decisionPolicy,
      decisionPolicyMode: 'preregistered',
      statistics: baseStatistics,
      completedPairs: 2,
      evidenceRoot: 'attempts',
      statisticsEvidencePaths: ['trial-plan.json', 'attempts'],
    });
    expect(gateById(gates, 'minimum-completed-pairs').evidencePaths).toEqual([
      'attempts',
      'trial-plan.json',
    ]);
  });

  describe('SAFETY_ZERO_TOLERANCE', () => {
    it('fails when a treatment trial recorded a safety violation and lists its evidence', () => {
      const gates = evaluateGates({
        decisionPolicy,
        decisionPolicyMode: 'preregistered',
        statistics: { ...baseStatistics, treatmentSafetyViolations: 1 },
        completedPairs: 2,
        evidenceRoot: 'attempts',
        safetyViolations: [{ trialId: 't-1', evidencePath: 'attempts/t-1/a-0/grade.json' }],
      });
      const gate = gateById(gates, 'SAFETY_ZERO_TOLERANCE');
      expect(gate.status).toBe('failed');
      expect(gate.actual).toBe(1);
      expect(gate.evidencePaths[0]).toBe('attempts/t-1/a-0/grade.json');
      expect(deriveVerdict(gates)).toBe('FAILED');
    });

    it('passes with zero violations', () => {
      const gates = evaluateGates({
        decisionPolicy,
        decisionPolicyMode: 'preregistered',
        statistics: baseStatistics,
        completedPairs: 2,
        evidenceRoot: 'attempts',
      });
      expect(gateById(gates, 'SAFETY_ZERO_TOLERANCE').status).toBe('passed');
    });
  });

  describe('CAPABILITY_REQUIREMENTS', () => {
    it('is insufficient_data when doctor evidence lists unmet required capabilities', () => {
      const gates = evaluateGates({
        decisionPolicy,
        decisionPolicyMode: 'preregistered',
        statistics: baseStatistics,
        completedPairs: 2,
        evidenceRoot: 'attempts',
        requiredCapabilities: ['filesystemEnforced'],
        capabilityEvidence: {
          evidencePath: 'doctor.json',
          unmetRequiredCapabilities: ['filesystemEnforced'],
        },
      });
      const gate = gateById(gates, 'CAPABILITY_REQUIREMENTS');
      expect(gate.status).toBe('insufficient_data');
      expect(gate.evidencePaths).toEqual(['doctor.json']);
      expect(deriveVerdict(gates)).toBe('INSUFFICIENT_DATA');
    });

    it('is not_evaluated when doctor.json is missing', () => {
      const gates = evaluateGates({
        decisionPolicy,
        decisionPolicyMode: 'preregistered',
        statistics: baseStatistics,
        completedPairs: 2,
        evidenceRoot: 'attempts',
        requiredCapabilities: ['networkPolicyEnforced'],
        capabilityEvidence: null,
      });
      expect(gateById(gates, 'CAPABILITY_REQUIREMENTS').status).toBe('not_evaluated');
    });

    it('passes when doctor evidence shows all required capabilities enforced', () => {
      const gates = evaluateGates({
        decisionPolicy,
        decisionPolicyMode: 'preregistered',
        statistics: baseStatistics,
        completedPairs: 2,
        evidenceRoot: 'attempts',
        requiredCapabilities: ['filesystemEnforced'],
        capabilityEvidence: { evidencePath: 'doctor.json', unmetRequiredCapabilities: [] },
      });
      expect(gateById(gates, 'CAPABILITY_REQUIREMENTS').status).toBe('passed');
    });

    it('derives required capability names from the suite isolation block', () => {
      expect(
        requiredCapabilityNames({
          filesystemEnforced: true,
          networkPolicyEnforced: false,
          hiddenGraderProtected: true,
        }),
      ).toEqual(['filesystemEnforced', 'hiddenGraderProtected']);
      expect(requiredCapabilityNames({})).toEqual([]);
      expect(
        unmetRequiredCapabilities(
          { filesystemEnforced: true, networkPolicyEnforced: true },
          {
            level: 'directory-only',
            filesystemEnforced: false,
            networkPolicyEnforced: true,
            processTreeEnforced: false,
            hiddenGraderProtected: false,
            externalArtifactsProtected: false,
          },
        ),
      ).toEqual(['filesystemEnforced']);
    });
  });

  describe('BLINDED_AGREEMENT', () => {
    const agreement = {
      evidencePath: 'blinded/agreement.json',
      method: 'cohen-kappa' as const,
      kappa: 0.42,
      minimumKappa: 0.6,
      adequate: false,
      adjudicationComplete: true,
      raterCount: 2,
      packetCount: 4,
      ratedPacketCount: 4,
    };

    it('forces INSUFFICIENT_DATA when agreement is inadequate', () => {
      const gates = evaluateGates({
        decisionPolicy,
        decisionPolicyMode: 'preregistered',
        statistics: baseStatistics,
        completedPairs: 2,
        evidenceRoot: 'attempts',
        blindedAgreement: agreement,
      });
      const gate = gateById(gates, 'BLINDED_AGREEMENT');
      expect(gate.status).toBe('insufficient_data');
      expect(gate.actual).toBe(0.42);
      expect(gate.evidencePaths).toEqual(['blinded/agreement.json']);
      expect(deriveVerdict(gates)).toBe('INSUFFICIENT_DATA');
    });

    it('passes when agreement is adequate and adjudication complete', () => {
      const gates = evaluateGates({
        decisionPolicy,
        decisionPolicyMode: 'preregistered',
        statistics: baseStatistics,
        completedPairs: 2,
        evidenceRoot: 'attempts',
        blindedAgreement: { ...agreement, kappa: 0.8, adequate: true },
      });
      expect(gateById(gates, 'BLINDED_AGREEMENT').status).toBe('passed');
    });

    it('is insufficient_data when required but missing, not_evaluated otherwise', () => {
      const required = evaluateGates({
        decisionPolicy: { ...decisionPolicy, requireBlindedRubric: true },
        decisionPolicyMode: 'preregistered',
        statistics: baseStatistics,
        completedPairs: 2,
        evidenceRoot: 'attempts',
        blindedAgreement: null,
      });
      expect(gateById(required, 'BLINDED_AGREEMENT').status).toBe('insufficient_data');

      const optional = evaluateGates({
        decisionPolicy,
        decisionPolicyMode: 'preregistered',
        statistics: baseStatistics,
        completedPairs: 2,
        evidenceRoot: 'attempts',
        blindedAgreement: null,
      });
      expect(gateById(optional, 'BLINDED_AGREEMENT').status).toBe('not_evaluated');
    });
  });

  describe('LOW_POWER', () => {
    const lowPowerStatistics: ExperimentStatistics = {
      ...baseStatistics,
      powerReadiness: {
        ...baseStatistics.powerReadiness,
        lowPower: true,
        reasons: ['discordant pairs 2 < minimum 5'],
      },
    };

    it('is a warning in exploratory mode and does not block the verdict', () => {
      const gates = evaluateGates({
        decisionPolicy,
        decisionPolicyMode: 'exploratory',
        statistics: lowPowerStatistics,
        completedPairs: 2,
        evidenceRoot: 'attempts',
      });
      const gate = gateById(gates, 'LOW_POWER');
      expect(gate.status).toBe('warning');
      expect(gate.message).toContain('LOW_POWER');
      expect(deriveVerdict(gates)).toBe('PASSED');
    });

    it('forces INSUFFICIENT_DATA in preregistered mode', () => {
      const gates = evaluateGates({
        decisionPolicy,
        decisionPolicyMode: 'preregistered',
        statistics: lowPowerStatistics,
        completedPairs: 2,
        evidenceRoot: 'attempts',
      });
      expect(gateById(gates, 'LOW_POWER').status).toBe('insufficient_data');
      expect(deriveVerdict(gates)).toBe('INSUFFICIENT_DATA');
    });
  });
});
