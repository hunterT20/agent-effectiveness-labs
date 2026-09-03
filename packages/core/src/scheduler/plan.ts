import { z } from 'zod';

import { computeFingerprint } from '../fingerprint/canonical.js';
import { createMulberry32, derivePrngSeed, PRNG_VERSION, shuffleDeterministic } from './prng.js';

export const TrialPlanEntrySchema = z
  .object({
    trialIndex: z.number().int().nonnegative(),
    blockIndex: z.number().int().nonnegative(),
    fixtureId: z.string().min(1),
    armId: z.string().min(1),
    repeatIndex: z.number().int().nonnegative(),
  })
  .strict();

export type TrialPlanEntry = z.infer<typeof TrialPlanEntrySchema>;

export const ArmComparisonSchema = z
  .object({
    controlArm: z.string().min(1),
    treatmentArm: z.string().min(1),
  })
  .strict();

export type ArmComparison = z.infer<typeof ArmComparisonSchema>;

export const TrialPlanCountsSchema = z
  .object({
    fixtures: z.number().int().nonnegative(),
    arms: z.number().int().nonnegative(),
    repeats: z.number().int().nonnegative(),
    blocks: z.number().int().nonnegative(),
    trials: z.number().int().nonnegative(),
    pairs: z.number().int().nonnegative(),
    independentFixtures: z.number().int().nonnegative(),
    agentInvocations: z.number().int().nonnegative(),
    timeoutExposureMs: z.number().int().nonnegative(),
  })
  .strict();

export type TrialPlanCounts = z.infer<typeof TrialPlanCountsSchema>;

export const TrialPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    randomSeed: z.string().min(1),
    prngVersion: z.literal(PRNG_VERSION),
    trials: z.array(TrialPlanEntrySchema),
    counts: TrialPlanCountsSchema,
    comparisons: z
      .object({
        primary: ArmComparisonSchema,
        secondary: z.array(ArmComparisonSchema),
      })
      .strict(),
    fingerprint: z.string(),
  })
  .strict();

export type TrialPlan = z.infer<typeof TrialPlanSchema>;

export const PreregistrationSchema = z
  .object({
    schemaVersion: z.literal(1),
    suiteFingerprint: z.string(),
    trialPlanFingerprint: z.string(),
    sealedAt: z.string(),
    randomSeed: z.string().min(1),
    primaryControlArm: z.string().min(1),
    primaryTreatmentArm: z.string().min(1),
    decisionPolicyMode: z.enum(['exploratory', 'preregistered']),
  })
  .strict();

export type Preregistration = z.infer<typeof PreregistrationSchema>;

export interface ScheduleInput {
  readonly fixtureIds: readonly string[];
  readonly armIds: readonly string[];
  readonly repeats: number;
  readonly randomSeed: string;
  readonly primaryControlArm: string;
  readonly primaryTreatmentArm: string;
  readonly timeoutMs: number;
  readonly phasesPerFixture: number;
}

interface ComparisonBlock {
  readonly fixtureId: string;
  readonly repeatIndex: number;
}

function buildSecondaryComparisons(
  armIds: readonly string[],
  primaryControlArm: string,
  primaryTreatmentArm: string,
): ArmComparison[] {
  const secondary: ArmComparison[] = [];
  for (const treatmentArm of armIds) {
    if (treatmentArm === primaryControlArm || treatmentArm === primaryTreatmentArm) {
      continue;
    }
    secondary.push({ controlArm: primaryControlArm, treatmentArm });
  }
  return secondary;
}

export function buildTrialPlan(input: ScheduleInput): TrialPlan {
  const blocks: ComparisonBlock[] = [];
  for (const fixtureId of input.fixtureIds) {
    for (let repeatIndex = 0; repeatIndex < input.repeats; repeatIndex += 1) {
      blocks.push({ fixtureId, repeatIndex });
    }
  }

  const rng = createMulberry32(derivePrngSeed(input.randomSeed));
  const shuffledBlocks = shuffleDeterministic(blocks, rng);

  const trials: TrialPlanEntry[] = [];
  let trialIndex = 0;

  for (let blockIndex = 0; blockIndex < shuffledBlocks.length; blockIndex += 1) {
    const block = shuffledBlocks[blockIndex];
    if (block === undefined) {
      continue;
    }
    const shuffledArms = shuffleDeterministic(input.armIds, rng);
    for (const armId of shuffledArms) {
      trials.push({
        trialIndex,
        blockIndex,
        fixtureId: block.fixtureId,
        armId,
        repeatIndex: block.repeatIndex,
      });
      trialIndex += 1;
    }
  }

  const pairs = input.fixtureIds.length * input.repeats;
  const agentInvocations = trials.length * input.phasesPerFixture;

  const planWithoutFingerprint: Omit<TrialPlan, 'fingerprint'> = {
    schemaVersion: 1,
    randomSeed: input.randomSeed,
    prngVersion: PRNG_VERSION,
    trials,
    counts: {
      fixtures: input.fixtureIds.length,
      arms: input.armIds.length,
      repeats: input.repeats,
      blocks: shuffledBlocks.length,
      trials: trials.length,
      pairs,
      independentFixtures: input.fixtureIds.length,
      agentInvocations,
      timeoutExposureMs: agentInvocations * input.timeoutMs,
    },
    comparisons: {
      primary: {
        controlArm: input.primaryControlArm,
        treatmentArm: input.primaryTreatmentArm,
      },
      secondary: buildSecondaryComparisons(
        input.armIds,
        input.primaryControlArm,
        input.primaryTreatmentArm,
      ),
    },
  };

  const fingerprint = computeFingerprint(planWithoutFingerprint);
  return { ...planWithoutFingerprint, fingerprint };
}

export interface SealPlanInput {
  readonly suiteFingerprint: string;
  readonly trialPlan: TrialPlan;
  readonly primaryControlArm: string;
  readonly primaryTreatmentArm: string;
  readonly decisionPolicyMode: 'exploratory' | 'preregistered';
  readonly sealedAt?: string;
}

export function sealPreregistration(input: SealPlanInput): Preregistration {
  return {
    schemaVersion: 1,
    suiteFingerprint: input.suiteFingerprint,
    trialPlanFingerprint: input.trialPlan.fingerprint,
    sealedAt: input.sealedAt ?? new Date().toISOString(),
    randomSeed: input.trialPlan.randomSeed,
    primaryControlArm: input.primaryControlArm,
    primaryTreatmentArm: input.primaryTreatmentArm,
    decisionPolicyMode: input.decisionPolicyMode,
  };
}

export function serializeTrialPlan(plan: TrialPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export function serializePreregistration(preregistration: Preregistration): string {
  return `${JSON.stringify(preregistration, null, 2)}\n`;
}
