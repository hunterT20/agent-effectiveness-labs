import { describe, expect, it } from 'vitest';

import { computeExperimentStatistics, type TrialMetricInput } from '@ael/core';

function trial(
  fixtureId: string,
  armId: string,
  repeatIndex: number,
  overrides: Partial<TrialMetricInput> = {},
): TrialMetricInput {
  return {
    fixtureId,
    armId,
    repeatIndex,
    status: 'completed',
    verifiedSuccess: false,
    infrastructureFailed: false,
    durationMs: 100,
    safetyViolation: false,
    ...overrides,
  };
}

describe('computeExperimentStatistics', () => {
  const trials: TrialMetricInput[] = [
    // f1: improvement
    trial('f1', 'control', 0, { verifiedSuccess: false, durationMs: 100 }),
    trial('f1', 'treatment', 0, { verifiedSuccess: true, durationMs: 200 }),
    // f2: regression
    trial('f2', 'control', 0, { verifiedSuccess: true, durationMs: 110 }),
    trial('f2', 'treatment', 0, { verifiedSuccess: false, durationMs: 210 }),
    // f3: tie (both success)
    trial('f3', 'control', 0, { verifiedSuccess: true, durationMs: 120 }),
    trial('f3', 'treatment', 0, { verifiedSuccess: true, durationMs: 220 }),
    // f4: missing pair (treatment infra failed)
    trial('f4', 'control', 0, { verifiedSuccess: true, durationMs: 130 }),
    trial('f4', 'treatment', 0, {
      status: 'infrastructure_failed',
      infrastructureFailed: true,
      durationMs: null,
    }),
    // f5: improvement, second repeat
    trial('f5', 'control', 1, { verifiedSuccess: false, durationMs: 140 }),
    trial('f5', 'treatment', 1, {
      verifiedSuccess: true,
      durationMs: 240,
      safetyViolation: true,
    }),
  ];

  it('builds the pair table, excludes missing pairs and counts discordant pairs', () => {
    const stats = computeExperimentStatistics({
      controlArm: 'control',
      treatmentArm: 'treatment',
      trials,
      randomSeed: 'seed',
      bootstrapIterations: 100,
      plannedPairs: 6,
    });

    expect(stats.trialCount).toBe(10);
    expect(stats.independentFixtureCount).toBe(5);
    expect(stats.completedPairs).toBe(4);
    expect(stats.missingPairs).toBe(2);
    expect(stats.discordantPairs).toBe(3);
    expect(stats.pairedSignTest).toMatchObject({ improvements: 2, regressions: 1, ties: 1 });
    // one-sided P(X >= 2 | n=3, p=0.5) = 4/8
    expect(stats.pairedSignTest.pValueOneSided).toBeCloseTo(0.5, 12);
    expect(stats.pairs.map((pair) => pair.outcome)).toEqual([
      'improvement',
      'regression',
      'tie',
      'missing',
      'improvement',
    ]);
    expect(stats.pairs[3]).toMatchObject({
      fixtureId: 'f4',
      controlStatus: 'completed',
      treatmentStatus: 'infrastructure_failed',
      controlSuccess: null,
      treatmentSuccess: null,
    });
  });

  it('reports per-arm rates over completed trials and infra failures over all trials', () => {
    const stats = computeExperimentStatistics({
      controlArm: 'control',
      treatmentArm: 'treatment',
      trials,
      randomSeed: 'seed',
      bootstrapIterations: 100,
    });
    // control: 5 completed, 3 successes; treatment: 4 completed, 3 successes
    expect(stats.controlVerifiedSuccessRate).toBeCloseTo(0.6, 12);
    expect(stats.treatmentVerifiedSuccessRate).toBeCloseTo(0.75, 12);
    expect(stats.verifiedSuccessDelta).toBeCloseTo(0.15, 12);
    expect(stats.infrastructureFailureRate).toBeCloseTo(0.1, 12);
    expect(stats.controlMedianDurationMs).toBe(120);
    expect(stats.treatmentMedianDurationMs).toBe(215);
    expect(stats.treatmentP95DurationMs).toBe(240);
    expect(stats.treatmentSafetyViolations).toBe(1);
    const treatmentArm = stats.arms.find((arm) => arm.armId === 'treatment');
    expect(treatmentArm).toMatchObject({
      trialCount: 5,
      completedCount: 4,
      verifiedSuccessCount: 3,
      infrastructureFailureCount: 1,
      safetyViolationCount: 1,
    });
  });

  it('bootstraps the mean per-fixture delta with the preregistered seed', () => {
    const stats = computeExperimentStatistics({
      controlArm: 'control',
      treatmentArm: 'treatment',
      trials,
      randomSeed: 'seed',
      bootstrapIterations: 100,
    });
    // fixture deltas: f1=+1, f2=-1, f3=0, f5=+1 → mean 0.25
    expect(stats.bootstrap.pointEstimate).toBeCloseTo(0.25, 12);
    expect(stats.bootstrap.resampledFixtureCount).toBe(4);
    expect(stats.bootstrap.method).toBe('percentile-cluster-resample');
    expect(stats.bootstrap.version).toBe('cluster-bootstrap-v2');
    expect(stats.methods.bootstrap).toBe('percentile-cluster-resample');
  });

  it('flags LOW_POWER when discordant pairs are below the minimum', () => {
    const stats = computeExperimentStatistics({
      controlArm: 'control',
      treatmentArm: 'treatment',
      trials,
      randomSeed: 'seed',
      bootstrapIterations: 50,
      minimumDiscordantPairs: 5,
    });
    expect(stats.powerReadiness.lowPower).toBe(true);
    expect(stats.powerReadiness.reasons[0]).toContain('discordant pairs 3 < minimum 5');
    expect(stats.powerReadiness.fixtureWarning?.code).toBe('UNDERPOWERED');
  });

  it('is not LOW_POWER with enough discordant pairs and fixtures for the target delta', () => {
    // 40 fixtures, control never succeeds, treatment always succeeds → 40 discordant pairs.
    const many: TrialMetricInput[] = [];
    for (let index = 0; index < 40; index += 1) {
      many.push(trial(`f${String(index)}`, 'control', 0, { verifiedSuccess: false }));
      many.push(trial(`f${String(index)}`, 'treatment', 0, { verifiedSuccess: true }));
    }
    const stats = computeExperimentStatistics({
      controlArm: 'control',
      treatmentArm: 'treatment',
      trials: many,
      randomSeed: 'seed',
      bootstrapIterations: 50,
      minimumDiscordantPairs: 5,
      minimumDetectableDelta: 0.5,
    });
    expect(stats.discordantPairs).toBe(40);
    expect(stats.powerReadiness.lowPower).toBe(false);
    expect(stats.powerReadiness.reasons).toEqual([]);
    expect(stats.powerReadiness.fixtureWarning).toBeNull();
  });

  it('applies Holm to secondary arms only when requested', () => {
    const withSecondary: TrialMetricInput[] = [
      ...trials,
      trial('f1', 'arm-x', 0, { verifiedSuccess: true }),
      trial('f2', 'arm-x', 0, { verifiedSuccess: true }),
      trial('f3', 'arm-x', 0, { verifiedSuccess: true }),
      trial('f4', 'arm-x', 0, { verifiedSuccess: true }),
      trial('f5', 'arm-x', 1, { verifiedSuccess: true }),
      trial('f1', 'arm-y', 0, { verifiedSuccess: true }),
      trial('f2', 'arm-y', 0, { verifiedSuccess: false }),
    ];
    const holm = computeExperimentStatistics({
      controlArm: 'control',
      treatmentArm: 'treatment',
      secondaryTreatmentArms: ['arm-x', 'arm-y'],
      trials: withSecondary,
      randomSeed: 'seed',
      bootstrapIterations: 50,
      multipleComparisonMethod: 'holm',
      alpha: 0.05,
    });
    expect(holm.holm?.method).toBe('holm');
    expect(holm.secondaryComparisons).toHaveLength(2);
    const armX = holm.secondaryComparisons.find((entry) => entry.treatmentArm === 'arm-x');
    const armY = holm.secondaryComparisons.find((entry) => entry.treatmentArm === 'arm-y');
    // arm-x: control fails f1, f5 → 2 improvements, 0 regressions → p = 0.25
    // arm-y: f1 improvement, f2 regression → p = P(X >= 1 | n=2) = 0.75
    // Holm (m=2): 0.25*2 = 0.5, then max(0.5, 0.75*1) = 0.75
    expect(armX?.rawPValue).toBeCloseTo(0.25, 12);
    expect(armX?.adjustedPValue).toBeCloseTo(0.5, 12);
    expect(armY?.rawPValue).toBeCloseTo(0.75, 12);
    expect(armY?.adjustedPValue).toBeCloseTo(0.75, 12);
    expect(holm.holm?.comparisons.map((entry) => entry.id)).toEqual(['arm-x', 'arm-y']);

    const none = computeExperimentStatistics({
      controlArm: 'control',
      treatmentArm: 'treatment',
      secondaryTreatmentArms: ['arm-x'],
      trials: withSecondary,
      randomSeed: 'seed',
      bootstrapIterations: 50,
      multipleComparisonMethod: 'none',
    });
    expect(none.holm).toBeNull();
    expect(none.secondaryComparisons[0]?.adjustedPValue).toBeNull();
  });

  it('is deterministic', () => {
    const input = {
      controlArm: 'control',
      treatmentArm: 'treatment',
      trials,
      randomSeed: 'seed',
      bootstrapIterations: 100,
    };
    expect(computeExperimentStatistics(input)).toEqual(computeExperimentStatistics(input));
  });
});
