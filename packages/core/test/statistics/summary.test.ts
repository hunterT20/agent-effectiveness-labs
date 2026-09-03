import { describe, expect, it } from 'vitest';

import {
  computeExperimentStatistics,
  computeRate,
  median,
  pairedSignTest,
  percentileNearestRank,
} from '@ael/core';

describe('statistics summary', () => {
  it('computes rates and null-safe ratios', () => {
    expect(computeRate(2, 4)).toBe(0.5);
    expect(computeRate(1, 0)).toBeNull();
  });

  it('computes median and nearest-rank percentiles', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(percentileNearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentileNearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });

  it('uses discordant fixture outcomes for the paired sign test', () => {
    const result = pairedSignTest([
      { fixtureId: 'a', controlSuccess: false, treatmentSuccess: true },
      { fixtureId: 'b', controlSuccess: true, treatmentSuccess: false },
      { fixtureId: 'c', controlSuccess: true, treatmentSuccess: true },
    ]);
    expect(result.improvements).toBe(1);
    expect(result.regressions).toBe(1);
    expect(result.ties).toBe(1);
    expect(result.pValueOneSided).not.toBeNull();
    expect(result.pValueTwoSided).not.toBeNull();
  });

  it('does not inflate independent fixture count with repeats', () => {
    const stats = computeExperimentStatistics({
      controlArm: 'control',
      treatmentArm: 'treatment',
      trials: [
        {
          fixtureId: 'f1',
          armId: 'control',
          repeatIndex: 0,
          verifiedSuccess: true,
          infrastructureFailed: false,
          durationMs: 100,
        },
        {
          fixtureId: 'f1',
          armId: 'treatment',
          repeatIndex: 0,
          verifiedSuccess: true,
          infrastructureFailed: false,
          durationMs: 120,
        },
        {
          fixtureId: 'f1',
          armId: 'control',
          repeatIndex: 1,
          verifiedSuccess: false,
          infrastructureFailed: false,
          durationMs: 90,
        },
        {
          fixtureId: 'f1',
          armId: 'treatment',
          repeatIndex: 1,
          verifiedSuccess: true,
          infrastructureFailed: false,
          durationMs: 110,
        },
      ],
    });
    expect(stats.independentFixtureCount).toBe(1);
    expect(stats.trialCount).toBe(4);
  });
});
