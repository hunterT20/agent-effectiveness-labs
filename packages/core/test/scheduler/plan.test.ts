import { describe, expect, it } from 'vitest';

import { buildTrialPlan, serializeTrialPlan } from '@ael/core';

const baseInput = {
  fixtureIds: ['fixture-a', 'fixture-b', 'fixture-c'],
  armIds: ['control', 'treatment'],
  repeats: 2,
  randomSeed: 'm1-test-seed',
  primaryControlArm: 'control',
  primaryTreatmentArm: 'treatment',
  timeoutMs: 60_000,
  phasesPerFixture: 1,
} as const;

describe('trial scheduler', () => {
  it('produces exact fixture × arm × repeat trial counts', () => {
    const plan = buildTrialPlan(baseInput);
    expect(plan.counts.fixtures).toBe(3);
    expect(plan.counts.arms).toBe(2);
    expect(plan.counts.repeats).toBe(2);
    expect(plan.counts.blocks).toBe(6);
    expect(plan.counts.trials).toBe(12);
    expect(plan.counts.pairs).toBe(6);
    expect(plan.trials).toHaveLength(12);
  });

  it('includes every arm in each comparison block', () => {
    const plan = buildTrialPlan(baseInput);
    const byBlock = new Map<number, string[]>();
    for (const trial of plan.trials) {
      const arms = byBlock.get(trial.blockIndex) ?? [];
      arms.push(trial.armId);
      byBlock.set(trial.blockIndex, arms);
    }

    for (const arms of byBlock.values()) {
      expect(new Set(arms)).toEqual(new Set(baseInput.armIds));
    }
  });

  it('shuffles blocks globally and arm order within blocks', () => {
    const plan = buildTrialPlan(baseInput);
    const firstBlockArms = plan.trials
      .filter((trial) => trial.blockIndex === 0)
      .map((trial) => trial.armId);
    expect(firstBlockArms).toHaveLength(2);

    const sequentialPlan = buildTrialPlan({
      ...baseInput,
      randomSeed: 'sequential-like-seed',
    });
    const hasVariedArmOrder = plan.trials.some((trial, index) => {
      const other = sequentialPlan.trials[index];
      return other !== undefined && trial.armId !== other.armId;
    });
    expect(
      hasVariedArmOrder || plan.trials[0]?.fixtureId !== sequentialPlan.trials[0]?.fixtureId,
    ).toBe(true);
  });

  it('yields byte-identical plan for the same seed', () => {
    const first = serializeTrialPlan(buildTrialPlan(baseInput));
    const second = serializeTrialPlan(buildTrialPlan(baseInput));
    expect(first).toBe(second);
  });

  it('changes order without changing membership for a different seed', () => {
    const first = buildTrialPlan(baseInput);
    const second = buildTrialPlan({ ...baseInput, randomSeed: 'different-seed' });
    expect(
      first.trials
        .map((trial) => `${trial.fixtureId}:${trial.armId}:${String(trial.repeatIndex)}`)
        .sort(),
    ).toEqual(
      second.trials
        .map((trial) => `${trial.fixtureId}:${trial.armId}:${String(trial.repeatIndex)}`)
        .sort(),
    );
    expect(serializeTrialPlan(first)).not.toBe(serializeTrialPlan(second));
  });

  it('declares the primary comparison explicitly', () => {
    const plan = buildTrialPlan(baseInput);
    expect(plan.comparisons.primary).toEqual({
      controlArm: 'control',
      treatmentArm: 'treatment',
    });
  });

  it('identifies secondary comparisons for multiplicity correction', () => {
    const plan = buildTrialPlan({
      ...baseInput,
      armIds: ['control', 'treatment', 'alt-treatment'],
    });
    expect(plan.comparisons.secondary).toEqual([
      { controlArm: 'control', treatmentArm: 'alt-treatment' },
    ]);
  });

  it('calculates timeout exposure from invocations', () => {
    const plan = buildTrialPlan({ ...baseInput, phasesPerFixture: 2, timeoutMs: 30_000 });
    expect(plan.counts.agentInvocations).toBe(24);
    expect(plan.counts.timeoutExposureMs).toBe(720_000);
  });
});
