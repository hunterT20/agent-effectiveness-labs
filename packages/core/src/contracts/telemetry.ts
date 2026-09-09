import { z } from 'zod';

import { NumericMetricValueSchema } from './metrics.js';

export const PricingComponentSchema = z
  .object({
    inputPerMillion: z.number().nullable(),
    outputPerMillion: z.number().nullable(),
    cachedInputPerMillion: z.number().nullable(),
    reasoningPerMillion: z.number().nullable(),
  })
  .strict();

export type PricingComponent = z.infer<typeof PricingComponentSchema>;

export const PricingModelEntrySchema = z
  .object({
    provider: z.string().min(1),
    components: PricingComponentSchema,
  })
  .strict();

export type PricingModelEntry = z.infer<typeof PricingModelEntrySchema>;

export const PricingSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    currency: z.string().min(1),
    effectiveAt: z.string().min(1),
    sourcePath: z.string().min(1),
    models: z.record(PricingModelEntrySchema),
    fingerprint: z.string(),
  })
  .strict();

export type PricingSnapshot = z.infer<typeof PricingSnapshotSchema>;

export const TrialTelemetrySchema = z
  .object({
    schemaVersion: z.literal(1),
    inputTokens: NumericMetricValueSchema,
    outputTokens: NumericMetricValueSchema,
    cachedInputTokens: NumericMetricValueSchema,
    reasoningTokens: NumericMetricValueSchema,
    subagentTokens: NumericMetricValueSchema,
    toolCalls: NumericMetricValueSchema,
    estimatedCostUsd: NumericMetricValueSchema,
    phaseCount: z.number().int().nonnegative(),
    rawArtifactPath: z.string().nullable(),
  })
  .strict();

export type TrialTelemetry = z.infer<typeof TrialTelemetrySchema>;

export interface TelemetryCoverageSummary {
  readonly exact: number;
  readonly estimated: number;
  readonly unavailable: number;
  readonly total: number;
}
