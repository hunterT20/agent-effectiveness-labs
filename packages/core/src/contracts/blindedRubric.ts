import { z } from 'zod';

/**
 * Rubric scores are 0..5 integers. For inter-rater agreement and adjudication
 * decisions every rubric field is collapsed to a categorical label:
 * `pass` when the score is >= RUBRIC_PASS_THRESHOLD, otherwise `fail`.
 */
export const RUBRIC_PASS_THRESHOLD = 3 as const;

export const RubricCategorySchema = z.enum(['pass', 'fail']);

export type RubricCategory = z.infer<typeof RubricCategorySchema>;

export function categorizeRubricScore(score: number): RubricCategory {
  return score >= RUBRIC_PASS_THRESHOLD ? 'pass' : 'fail';
}

const RubricScoreSchema = z
  .object({
    criterionId: z.string().min(1),
    score: z.number().int().min(0).max(5),
    notes: z.string().optional(),
  })
  .strict();

export type RubricScore = z.infer<typeof RubricScoreSchema>;

export const RubricCriterionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string(),
  })
  .strict();

export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;

/**
 * A blinded packet is what a human rater sees. It must never carry arm identity,
 * trial identity, fixture identity, or any hidden-grader outcome.
 */
export const BlindedPacketSchema = z
  .object({
    packetId: z.string().min(1),
    presentationOrder: z.number().int().nonnegative(),
    prompt: z.string(),
    candidatePatch: z.string(),
    rubricCriteria: z.array(RubricCriterionSchema),
  })
  .strict();

export type BlindedPacket = z.infer<typeof BlindedPacketSchema>;

export const BlindedExportSchema = z
  .object({
    schemaVersion: z.literal(1),
    experimentId: z.string().min(1),
    packets: z.array(BlindedPacketSchema),
  })
  .strict();

export type BlindedExport = z.infer<typeof BlindedExportSchema>;

export function parseBlindedExport(input: unknown): BlindedExport {
  return BlindedExportSchema.parse(input);
}

export const PACKET_KEY_WARNING =
  'UNBLINDING KEY: maps packet ids to trial and arm identity. Never share with raters.' as const;

export const BlindedPacketKeyEntrySchema = z
  .object({
    packetId: z.string().min(1),
    trialId: z.string().min(1),
    attemptId: z.string().min(1),
    fixtureId: z.string().min(1),
    armId: z.string().min(1),
  })
  .strict();

export type BlindedPacketKeyEntry = z.infer<typeof BlindedPacketKeyEntrySchema>;

/** Kept separate from packets.json; it is the only artifact that unblinds packets. */
export const BlindedPacketKeySchema = z
  .object({
    schemaVersion: z.literal(1),
    experimentId: z.string().min(1),
    exportSeed: z.string().min(1),
    warning: z.literal(PACKET_KEY_WARNING),
    entries: z.array(BlindedPacketKeyEntrySchema),
  })
  .strict();

export type BlindedPacketKey = z.infer<typeof BlindedPacketKeySchema>;

export const BlindedAdjudicationSchema = z
  .object({
    adjudicatorId: z.string().min(1),
    finalScores: z.array(RubricScoreSchema).min(1),
    reason: z.string().min(1),
  })
  .strict();

export type BlindedAdjudication = z.infer<typeof BlindedAdjudicationSchema>;

export const BlindedRatingSchema = z
  .object({
    packetId: z.string().min(1),
    raterId: z.string().min(1),
    scores: z.array(RubricScoreSchema).min(1),
    adjudication: BlindedAdjudicationSchema.optional(),
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

/** Shape of the ratings file handed to `ael grade import`. */
export const BlindedRatingsFileSchema = z
  .object({
    schemaVersion: z.literal(1).optional(),
    experimentId: z.string().min(1).optional(),
    ratings: z.array(BlindedRatingSchema).min(1),
  })
  .strict();

export type BlindedRatingsFile = z.infer<typeof BlindedRatingsFileSchema>;

export function parseBlindedRatingsFile(input: unknown): BlindedRatingsFile {
  return BlindedRatingsFileSchema.parse(input);
}

export const AgreementMethodSchema = z.enum(['cohen-kappa', 'fleiss-kappa', 'percent-agreement']);

export type AgreementMethod = z.infer<typeof AgreementMethodSchema>;

/**
 * Written to `<experimentRoot>/blinded/agreement.json` by `ael grade import`.
 * Consumed by the verdict gate; the shape is a contract and must stay exact.
 */
export const BlindedAgreementSchema = z
  .object({
    schemaVersion: z.literal(1),
    method: AgreementMethodSchema,
    kappa: z.number().nullable(),
    raterCount: z.number().int().nonnegative(),
    packetCount: z.number().int().nonnegative(),
    ratedPacketCount: z.number().int().nonnegative(),
    minimumKappa: z.number(),
    adequate: z.boolean(),
    adjudicationComplete: z.boolean(),
  })
  .strict();

export type BlindedAgreement = z.infer<typeof BlindedAgreementSchema>;

export function parseBlindedAgreement(input: unknown): BlindedAgreement {
  return BlindedAgreementSchema.parse(input);
}

const NormalizedRaterEntrySchema = z
  .object({
    raterId: z.string().min(1),
    scores: z.array(RubricScoreSchema),
    categories: z.record(z.string().min(1), RubricCategorySchema),
  })
  .strict();

export const NormalizedPacketRatingSchema = z
  .object({
    packetId: z.string().min(1),
    raters: z.array(NormalizedRaterEntrySchema),
    disagreementCriteria: z.array(z.string().min(1)),
    adjudicationRequired: z.boolean(),
    adjudication: BlindedAdjudicationSchema.nullable(),
    finalCategories: z.record(z.string().min(1), RubricCategorySchema).nullable(),
  })
  .strict();

export type NormalizedPacketRating = z.infer<typeof NormalizedPacketRatingSchema>;

export const CriterionAgreementSchema = z
  .object({
    criterionId: z.string().min(1),
    method: AgreementMethodSchema,
    kappa: z.number().nullable(),
    observedAgreement: z.number(),
    reason: z.string().nullable(),
  })
  .strict();

export type CriterionAgreement = z.infer<typeof CriterionAgreementSchema>;

export const NormalizedRatingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    experimentId: z.string().min(1),
    raterIds: z.array(z.string().min(1)),
    criterionIds: z.array(z.string().min(1)),
    packets: z.array(NormalizedPacketRatingSchema),
    perCriterion: z.array(CriterionAgreementSchema),
    unratedPacketIds: z.array(z.string().min(1)),
  })
  .strict();

export type NormalizedRatings = z.infer<typeof NormalizedRatingsSchema>;
