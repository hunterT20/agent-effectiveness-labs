import { z } from 'zod';

import { AEL_ERROR_CODES } from './error-codes.js';

export const MetricQualitySchema = z.enum(['exact', 'estimated', 'unavailable'], {
  errorMap: () => ({
    message: AEL_ERROR_CODES.CONFIG_INVALID_TELEMETRY_QUALITY,
  }),
});

export type MetricQuality = z.infer<typeof MetricQualitySchema>;

export function metricValueSchema<T extends z.ZodType>(valueSchema: T) {
  return z
    .object({
      value: z.union([valueSchema, z.null()]),
      quality: MetricQualitySchema,
      source: z.string().nullable(),
      coverageReason: z.string().nullable(),
    })
    .strict();
}

export type MetricValue<T> = {
  value: T | null;
  quality: MetricQuality;
  source: string | null;
  coverageReason: string | null;
};

export const NumericMetricValueSchema = metricValueSchema(z.number());
