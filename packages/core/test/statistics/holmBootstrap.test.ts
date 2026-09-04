import { describe, expect, it } from 'vitest';

import { applyHolmCorrection, clusterBootstrapCi } from '@ael/core';

function adjusted(result: ReturnType<typeof applyHolmCorrection>, id: string): number {
  const entry = result.comparisons.find((comparison) => comparison.id === id);
  if (entry === undefined) {
    throw new Error(`missing comparison ${id}`);
  }
  return entry.adjustedPValue;
}

describe('holm adjusted p-values', () => {
  it('matches hand-computed step-down values (m=3)', () => {
    // sorted p: 0.01, 0.04, 0.2 → factors 3, 2, 1 → 0.03, 0.08, 0.2 (already monotone)
    const result = applyHolmCorrection({
      comparisons: [
        { id: 'arm-b', pValue: 0.04 },
        { id: 'arm-c', pValue: 0.01 },
        { id: 'arm-d', pValue: 0.2 },
      ],
      alpha: 0.05,
    });
    expect(result.version).toBe('holm-v2');
    expect(adjusted(result, 'arm-c')).toBeCloseTo(0.03, 12);
    expect(adjusted(result, 'arm-b')).toBeCloseTo(0.08, 12);
    expect(adjusted(result, 'arm-d')).toBeCloseTo(0.2, 12);
    expect(result.comparisons.map((entry) => entry.rank)).toEqual([1, 2, 3]);
  });

  it('enforces monotone adjusted p-values via cumulative max', () => {
    // sorted p: 0.01, 0.02, 0.03 → raw step-down 0.03, 0.04, 0.03 → cummax 0.03, 0.04, 0.04
    const result = applyHolmCorrection({
      comparisons: [
        { id: 'a', pValue: 0.01 },
        { id: 'b', pValue: 0.02 },
        { id: 'c', pValue: 0.03 },
      ],
      alpha: 0.05,
    });
    expect(adjusted(result, 'a')).toBeCloseTo(0.03, 12);
    expect(adjusted(result, 'b')).toBeCloseTo(0.04, 12);
    expect(adjusted(result, 'c')).toBeCloseTo(0.04, 12);
    expect(result.comparisons.every((entry) => entry.significant)).toBe(true);
  });

  it('caps adjusted p-values at 1 and flags significance from the adjusted value', () => {
    // sorted p: 0.5, 0.6 → 1.0, 0.6 → cummax 1.0, 1.0
    const result = applyHolmCorrection({
      comparisons: [
        { id: 'x', pValue: 0.6 },
        { id: 'y', pValue: 0.5 },
      ],
      alpha: 0.05,
    });
    expect(adjusted(result, 'y')).toBe(1);
    expect(adjusted(result, 'x')).toBe(1);
    expect(result.comparisons.every((entry) => !entry.significant)).toBe(true);
  });

  it('reduces to the raw p-value for a single comparison', () => {
    const result = applyHolmCorrection({ comparisons: [{ id: 'only', pValue: 0.04 }] });
    expect(adjusted(result, 'only')).toBeCloseTo(0.04, 12);
    expect(result.comparisons[0]?.significant).toBe(true);
  });

  it('breaks ties deterministically by id', () => {
    const result = applyHolmCorrection({
      comparisons: [
        { id: 'zeta', pValue: 0.02 },
        { id: 'alpha', pValue: 0.02 },
      ],
    });
    expect(result.comparisons.map((entry) => entry.id)).toEqual(['alpha', 'zeta']);
    expect(adjusted(result, 'alpha')).toBeCloseTo(0.04, 12);
    expect(adjusted(result, 'zeta')).toBeCloseTo(0.04, 12);
  });
});

describe('cluster bootstrap point estimate', () => {
  it('uses the mean of fixture values (same statistic as the resampled distribution)', () => {
    const result = clusterBootstrapCi({
      fixtureValues: [
        { fixtureId: 'a', value: 0 },
        { fixtureId: 'b', value: 0 },
        { fixtureId: 'c', value: 1 },
      ],
      randomSeed: 'seed',
      iterations: 200,
    });
    // median would be 0; mean is 1/3
    expect(result.pointEstimate).toBeCloseTo(1 / 3, 12);
    expect(result.statistic).toBe('mean');
    expect(result.version).toBe('cluster-bootstrap-v2');
    expect(result.lower).not.toBeNull();
    expect(result.upper).not.toBeNull();
    expect(result.lower ?? 0).toBeLessThanOrEqual(result.pointEstimate ?? 0);
    expect(result.upper ?? 0).toBeGreaterThanOrEqual(result.pointEstimate ?? 0);
  });

  it('is deterministic for the same seed and differs for another seed', () => {
    const fixtureValues = Array.from({ length: 12 }, (_, index) => ({
      fixtureId: `f${String(index)}`,
      value: index % 3 === 0 ? 1 : index % 3 === 1 ? 0 : -1,
    }));
    const first = clusterBootstrapCi({ fixtureValues, randomSeed: 'one', iterations: 300 });
    const second = clusterBootstrapCi({ fixtureValues, randomSeed: 'one', iterations: 300 });
    const other = clusterBootstrapCi({ fixtureValues, randomSeed: 'two', iterations: 300 });
    expect(first).toEqual(second);
    expect(first.pointEstimate).toBe(other.pointEstimate);
    expect([first.lower, first.upper]).not.toEqual([other.lower, other.upper]);
  });

  it('returns nulls without fixtures', () => {
    const result = clusterBootstrapCi({ fixtureValues: [], randomSeed: 'seed' });
    expect(result.pointEstimate).toBeNull();
    expect(result.lower).toBeNull();
    expect(result.resampledFixtureCount).toBe(0);
  });
});
