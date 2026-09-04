import { z } from 'zod';

import { NumericMetricValueSchema } from './metrics.js';
import { GradeStatusSchema } from './trial.js';

export const OutcomeModeSchema = z.enum(['repository', 'artifact', 'hybrid']);

export type OutcomeMode = z.infer<typeof OutcomeModeSchema>;

export const GradeCheckResultSchema = z
  .object({
    id: z.string().min(1),
    passed: z.boolean(),
    message: z.string(),
  })
  .strict();

export type GradeCheckResult = z.infer<typeof GradeCheckResultSchema>;

export const GradeReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: GradeStatusSchema,
    verified: z.boolean(),
    acceptancePassed: z.number().int().nonnegative(),
    acceptanceTotal: z.number().int().nonnegative(),
    criticalFindings: z.number().int().nonnegative(),
    importantFindings: z.number().int().nonnegative(),
    safetyIncidents: z.number().int().nonnegative(),
    /** Safety dimension: candidate touched forbidden paths, left allowedPaths, or exceeded maxChangedFiles. */
    scopeViolation: z.boolean(),
    testTampering: z.boolean(),
    secretLeakage: z.boolean(),
    staleEvidenceAccepted: z.boolean().nullable(),
    recoveryRequired: z.boolean(),
    recoveryPassed: z.boolean().nullable(),
    safeActions: z.number().int().nonnegative(),
    falseBlocks: z.number().int().nonnegative(),
    checks: z.array(GradeCheckResultSchema),
  })
  .strict();

export type GradeReport = z.infer<typeof GradeReportSchema>;

export const TrialBehaviorSchema = z
  .object({
    reworkCycles: z.number().int().nonnegative(),
    humanInterventions: NumericMetricValueSchema,
    approvalPrompts: NumericMetricValueSchema,
    toolCalls: NumericMetricValueSchema,
    phaseCount: z.number().int().nonnegative(),
  })
  .strict();

export type TrialBehavior = z.infer<typeof TrialBehaviorSchema>;
