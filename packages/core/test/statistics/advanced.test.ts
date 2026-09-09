import { describe, expect, it } from 'vitest';

import {
  applyHolmCorrection,
  assessPowerReadiness,
  clusterBootstrapCi,
  cohenKappa,
  interRaterAgreementForPackets,
} from '@ael/core';

describe('cluster bootstrap', () => {
  it('resamples fixtures deterministically and records method/version', () => {
    const input = {
      fixtureValues: [
        { fixtureId: 'a', value: 1 },
        { fixtureId: 'b', value: 3 },
        { fixtureId: 'c', value: 5 },
      ],
      randomSeed: 'bootstrap-seed',
      iterations: 500,
    };
    const first = clusterBootstrapCi(input);
    const second = clusterBootstrapCi(input);
    expect(first.method).toBe('percentile-cluster-resample');
    expect(first.version).toBe('cluster-bootstrap-v2');
    expect(first.lower).not.toBeNull();
    expect(first.upper).not.toBeNull();
    expect(first).toEqual(second);
  });
});

describe('holm correction', () => {
  it('adjusts secondary comparisons deterministically', () => {
    const result = applyHolmCorrection({
      comparisons: [
        { id: 'arm-b', pValue: 0.04 },
        { id: 'arm-c', pValue: 0.01 },
        { id: 'arm-d', pValue: 0.2 },
      ],
      alpha: 0.05,
    });
    expect(result.method).toBe('holm');
    expect(result.comparisons.find((entry) => entry.id === 'arm-c')?.significant).toBe(true);
    expect(result.comparisons.find((entry) => entry.id === 'arm-b')?.significant).toBe(false);
    expect(result.comparisons.find((entry) => entry.id === 'arm-d')?.significant).toBe(false);
  });
});

describe('power readiness', () => {
  it('warns when planned fixtures cannot detect the requested effect', () => {
    const warning = assessPowerReadiness({
      independentFixtureCount: 3,
      minimumDetectableDelta: 0.4,
      baselineSuccessRate: 0.2,
    });
    expect(warning).not.toBeNull();
    expect(warning?.code).toBe('UNDERPOWERED');
    expect(warning?.requiredFixtureCount).toBeGreaterThan(3);
  });
});

describe('inter-rater agreement', () => {
  it('computes kappa for blinded rubric raters', () => {
    const kappa = cohenKappa(['pass', 'pass', 'fail', 'pass'], ['pass', 'fail', 'fail', 'pass']);
    expect(kappa.kappa).not.toBeNull();
    expect(kappa.observedAgreement).toBeCloseTo(0.75);

    const packetKappa = interRaterAgreementForPackets([
      { raterId: 'r1', packetId: 'p1', category: 'pass' },
      { raterId: 'r2', packetId: 'p1', category: 'pass' },
      { raterId: 'r1', packetId: 'p2', category: 'fail' },
      { raterId: 'r2', packetId: 'p2', category: 'fail' },
    ]);
    expect(packetKappa?.kappa).toBe(1);
  });
});
