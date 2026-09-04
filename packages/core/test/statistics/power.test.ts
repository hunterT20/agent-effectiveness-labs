import { describe, expect, it } from 'vitest';

import { POWER_READINESS_VERSION, assessPowerReadiness, estimateRequiredFixtureCount } from '@ael/core';

describe('power readiness (paired binary sample size)', () => {
  it('matches the McNemar / Connor approximation for a moderate effect', () => {
    // baseline 0.5, delta 0.2 → treatment 0.7, pd = 0.5*0.3 + 0.5*0.7 = 0.5
    // n = (1.645*sqrt(0.5) + 0.842*sqrt(0.5 - 0.04))^2 / 0.04 ≈ 75
    const required = estimateRequiredFixtureCount({
      independentFixtureCount: 0,
      minimumDetectableDelta: 0.2,
      baselineSuccessRate: 0.5,
    });
    expect(required).toBeGreaterThanOrEqual(74);
    expect(required).toBeLessThanOrEqual(77);
    expect(POWER_READINESS_VERSION).toBe('power-readiness-v2');
  });

  it('requires fewer fixtures for a large effect', () => {
    // baseline 0, delta 0.5 → pd = 0.5, n = (1.645*0.707 + 0.842*0.5)^2 / 0.25 ≈ 10.04 → 11
    const required = estimateRequiredFixtureCount({
      independentFixtureCount: 0,
      minimumDetectableDelta: 0.5,
      baselineSuccessRate: 0,
    });
    expect(required).toBe(11);
  });

  it('returns infinity when the delta is not detectable (baseline already at ceiling)', () => {
    expect(
      estimateRequiredFixtureCount({
        independentFixtureCount: 10,
        minimumDetectableDelta: 0.2,
        baselineSuccessRate: 1,
      }),
    ).toBe(Number.POSITIVE_INFINITY);
    const warning = assessPowerReadiness({
      independentFixtureCount: 10,
      minimumDetectableDelta: 0.2,
      baselineSuccessRate: 1,
    });
    expect(warning?.requiredFixtureCount).toBe(Number.POSITIVE_INFINITY);
  });

  it('does not warn when planned fixtures meet the requirement', () => {
    expect(
      assessPowerReadiness({
        independentFixtureCount: 80,
        minimumDetectableDelta: 0.2,
        baselineSuccessRate: 0.5,
      }),
    ).toBeNull();
  });
});
