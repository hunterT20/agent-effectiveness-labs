import { describe, expect, it } from 'vitest';

import {
  computeAttemptId,
  computePairId,
  computeTrialId,
  type AttemptIdentityInput,
  type PairIdentityInput,
  type TrialIdentityInput,
} from '@ael/core';

describe('structured identity IDs', () => {
  const trialInput: TrialIdentityInput = {
    experimentFingerprint: 'exp-a',
    suiteFingerprint: 'suite-a',
    fixtureFingerprint: 'fixture-a',
    armFingerprint: 'arm-a',
    agentFingerprint: 'agent-a',
    isolationFingerprint: 'iso-a',
    pricingFingerprint: 'price-a',
    repeatIndex: 0,
  };

  const pairInput: PairIdentityInput = {
    experimentFingerprint: 'exp-a',
    suiteFingerprint: 'suite-a',
    fixtureFingerprint: 'fixture-a',
    controlArmFingerprint: 'arm-control',
    treatmentArmFingerprint: 'arm-treatment',
    repeatIndex: 0,
  };

  it('derives stable trial IDs from canonical structured inputs', () => {
    const first = computeTrialId(trialInput);
    const second = computeTrialId({ ...trialInput });

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('prevents ambiguous trial-ID concatenation collisions', () => {
    const left = computeTrialId({
      ...trialInput,
      experimentFingerprint: 'ab',
      suiteFingerprint: 'cd',
    });
    const right = computeTrialId({
      ...trialInput,
      experimentFingerprint: 'a',
      suiteFingerprint: 'bcd',
    });

    expect(left).not.toBe(right);
  });

  it('derives stable pair and attempt IDs from canonical structured inputs', () => {
    const pairId = computePairId(pairInput);
    const attemptInput: AttemptIdentityInput = {
      trialId: computeTrialId(trialInput),
      attemptIndex: 1,
    };

    expect(pairId).toMatch(/^[0-9a-f]{64}$/);
    expect(computeAttemptId(attemptInput)).toMatch(/^[0-9a-f]{64}$/);
    expect(computePairId({ ...pairInput })).toBe(pairId);
  });
});
