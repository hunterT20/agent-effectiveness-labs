import { z } from 'zod';

export const TrialStatusSchema = z.enum([
  'pending',
  'preparing',
  'running',
  'collecting',
  'grading',
  'completed',
  'agent_failed',
  'timed_out',
  'infrastructure_failed',
  'cancelled',
]);

export type TrialStatus = z.infer<typeof TrialStatusSchema>;

export const GradeStatusSchema = z.enum([
  'verified_success',
  'incorrect',
  'partial',
  'invalid_trial',
  'not_graded',
]);

export type GradeStatus = z.infer<typeof GradeStatusSchema>;

export const TrialIdentityInputSchema = z
  .object({
    experimentFingerprint: z.string(),
    suiteFingerprint: z.string(),
    fixtureFingerprint: z.string(),
    armFingerprint: z.string(),
    agentFingerprint: z.string(),
    isolationFingerprint: z.string(),
    pricingFingerprint: z.string(),
    repeatIndex: z.number().int().nonnegative(),
  })
  .strict();

export type TrialIdentityInput = z.infer<typeof TrialIdentityInputSchema>;
