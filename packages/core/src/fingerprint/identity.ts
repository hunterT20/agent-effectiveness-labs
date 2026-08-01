import { z } from 'zod';

import { TrialIdentityInputSchema, type TrialIdentityInput } from '../contracts/trial.js';
import { computeFingerprint } from './canonical.js';

export const PairIdentityInputSchema = z
  .object({
    experimentFingerprint: z.string(),
    suiteFingerprint: z.string(),
    fixtureFingerprint: z.string(),
    controlArmFingerprint: z.string(),
    treatmentArmFingerprint: z.string(),
    repeatIndex: z.number().int().nonnegative(),
  })
  .strict();

export type PairIdentityInput = z.infer<typeof PairIdentityInputSchema>;

export const AttemptIdentityInputSchema = z
  .object({
    trialId: z.string(),
    attemptIndex: z.number().int().nonnegative(),
  })
  .strict();

export type AttemptIdentityInput = z.infer<typeof AttemptIdentityInputSchema>;

function identityFingerprint(identityKind: 'trial' | 'pair' | 'attempt', input: unknown): string {
  return computeFingerprint({
    identityKind,
    input,
  });
}

export function computeTrialId(input: TrialIdentityInput): string {
  const normalized = TrialIdentityInputSchema.parse(input);
  return identityFingerprint('trial', normalized);
}

export function computePairId(input: PairIdentityInput): string {
  const normalized = PairIdentityInputSchema.parse(input);
  return identityFingerprint('pair', normalized);
}

export function computeAttemptId(input: AttemptIdentityInput): string {
  const normalized = AttemptIdentityInputSchema.parse(input);
  return identityFingerprint('attempt', normalized);
}
