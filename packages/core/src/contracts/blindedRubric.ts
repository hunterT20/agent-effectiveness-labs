import { z } from 'zod';

const RubricScoreSchema = z
  .object({
    criterionId: z.string().min(1),
    score: z.number().int().min(0).max(5),
    notes: z.string().optional(),
  })
  .strict();

export const BlindedPacketSchema = z
  .object({
    packetId: z.string().min(1),
    presentationOrder: z.number().int().nonnegative(),
    fixtureId: z.string().min(1),
    trialId: z.string().min(1),
    promptExcerpt: z.string(),
    outcomeSummary: z.string(),
    rubricCriteria: z.array(
      z
        .object({
          id: z.string().min(1),
          label: z.string().min(1),
          description: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export type BlindedPacket = z.infer<typeof BlindedPacketSchema>;

export const BlindedExportSchema = z
  .object({
    schemaVersion: z.literal(1),
    experimentId: z.string().min(1),
    exportSeed: z.string().min(1),
    packets: z.array(BlindedPacketSchema),
  })
  .strict();

export type BlindedExport = z.infer<typeof BlindedExportSchema>;

export const BlindedRatingSchema = z
  .object({
    packetId: z.string().min(1),
    raterId: z.string().min(1),
    scores: z.array(RubricScoreSchema).min(1),
    adjudication: z
      .object({
        adjudicatorId: z.string().min(1),
        finalScores: z.array(RubricScoreSchema).min(1),
        reason: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export type BlindedRating = z.infer<typeof BlindedRatingSchema>;

export const BlindedImportSchema = z
  .object({
    schemaVersion: z.literal(1),
    experimentId: z.string().min(1),
    ratings: z.array(BlindedRatingSchema).min(1),
  })
  .strict();

export type BlindedImport = z.infer<typeof BlindedImportSchema>;
