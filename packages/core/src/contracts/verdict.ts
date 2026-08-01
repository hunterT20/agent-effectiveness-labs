import { z } from 'zod';

export const GateStatusSchema = z.enum(['passed', 'failed', 'insufficient_data']);

export type GateStatus = z.infer<typeof GateStatusSchema>;

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
