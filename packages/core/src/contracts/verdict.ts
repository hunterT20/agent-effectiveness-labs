import { z } from 'zod';

/**
 * Gate outcome.
 *
 * - `passed` / `failed` / `insufficient_data` drive the verdict (fail-closed).
 * - `warning` never blocks a verdict but must be rendered prominently (e.g. LOW_POWER in exploratory mode).
 * - `not_evaluated` records that the gate had no evidence to inspect and nothing required it.
 */
export const GateStatusSchema = z.enum([
  'passed',
  'failed',
  'insufficient_data',
  'warning',
  'not_evaluated',
]);

export type GateStatus = z.infer<typeof GateStatusSchema>;

export const GATE_IDS = {
  MINIMUM_COMPLETED_PAIRS: 'minimum-completed-pairs',
  MINIMUM_INDEPENDENT_FIXTURES: 'minimum-independent-fixtures',
  MAXIMUM_INFRASTRUCTURE_FAILURE_RATE: 'maximum-infrastructure-failure-rate',
  VERIFIED_SUCCESS_DELTA: 'verified-success-delta',
  PAIRED_IMPROVEMENT_SIGNIFICANCE: 'paired-improvement-significance',
  SAFETY_ZERO_TOLERANCE: 'SAFETY_ZERO_TOLERANCE',
  CAPABILITY_REQUIREMENTS: 'CAPABILITY_REQUIREMENTS',
  BLINDED_AGREEMENT: 'BLINDED_AGREEMENT',
  LOW_POWER: 'LOW_POWER',
} as const;

export type GateId = (typeof GATE_IDS)[keyof typeof GATE_IDS];

export const GateResultSchema = z
  .object({
    id: z.string().min(1),
    status: GateStatusSchema,
    actual: z.number().nullable(),
    expected: z.string(),
    evidencePaths: z.array(z.string()),
    message: z.string(),
  })
  .strict();

export type GateResult = z.infer<typeof GateResultSchema>;
