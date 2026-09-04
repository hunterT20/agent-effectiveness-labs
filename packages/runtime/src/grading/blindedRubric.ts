import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import {
  BlindedAgreementSchema,
  BlindedExportSchema,
  BlindedImportSchema,
  BlindedPacketKeySchema,
  CandidateSnapshotSchema,
  NormalizedRatingsSchema,
  PACKET_KEY_WARNING,
  TrialPlanEntrySchema,
  categorizeRubricScore,
  cohenKappa,
  computeAttemptId,
  createMulberry32,
  derivePrngSeed,
  fleissKappa,
  isInside,
  shuffleDeterministic,
  type AgreementMethod,
  type BlindedAdjudication,
  type BlindedAgreement,
  type BlindedExport,
  type BlindedImport,
  type BlindedPacketKey,
  type BlindedRating,
  type CriterionAgreement,
  type NormalizedPacketRating,
  type NormalizedRatings,
  type RubricCategory,
  type RubricCriterion,
} from '@ael/core';
import { z } from 'zod';

import { writeAtomicJson } from '../artifacts/atomicWrite.js';
import type { ProtectedBlobStore } from '../artifacts/encryption.js';

// ---------------------------------------------------------------------------
// Trial discovery
// ---------------------------------------------------------------------------

export interface TrialGradeRecord {
  readonly trialId: string;
  readonly attemptId: string;
  readonly fixtureId: string;
  readonly armId: string;
  /** Full prompt text shown to the agent (fixture phase 0). */
  readonly prompt: string;
  /** Unified diff produced by the agent, or a placeholder when it cannot be read. */
  readonly candidatePatch: string;
}

const BlindedTrialStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    trialId: z.string().min(1),
    attemptId: z.string().min(1),
    status: z.string().min(1),
    planEntry: TrialPlanEntrySchema,
  })
  .passthrough();

const ProtectedBlobRefSchema = z
  .object({
    blobId: z.string().min(1),
    plaintextSha256: z.string(),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();

const StoredCandidateSnapshotSchema = CandidateSnapshotSchema.extend({
  protectedPatchRef: ProtectedBlobRefSchema.nullable().optional(),
  protectedUntrackedRef: ProtectedBlobRefSchema.nullable().optional(),
});

const PROTECTED_BLOB_PREFIX = 'protected-blobs/';

export const PROTECTED_PATCH_PLACEHOLDER =
  '[candidate patch is stored as a protected blob; set AEL_RUN_KEY_FILE to export it]';

export interface LoadTrialGradeRecordsOptions {
  /** fixtureId -> prompt text (phase 0). Trials whose fixture is missing are skipped. */
  readonly fixturePrompts: ReadonlyMap<string, string>;
  readonly protectedBlobStore?: ProtectedBlobStore;
  readonly warn?: (message: string) => void;
}

interface DiscoveredAttempt {
  readonly attemptDir: string;
  readonly attemptIndex: number;
  readonly state: z.infer<typeof BlindedTrialStateSchema>;
}

async function readJsonUnknown(path: string): Promise<unknown> {
  const raw = await readFile(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  return parsed;
}

async function listDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function resolveAttemptIndex(trialId: string, attemptIds: readonly string[]): Map<string, number> {
  // Attempt ids are fingerprints of {trialId, attemptIndex}; recompute to recover ordering.
  const indexById = new Map<string, number>();
  const probeLimit = attemptIds.length + 8;
  for (let attemptIndex = 0; attemptIndex < probeLimit; attemptIndex += 1) {
    indexById.set(computeAttemptId({ trialId, attemptIndex }), attemptIndex);
  }
  const resolved = new Map<string, number>();
  for (const attemptId of attemptIds) {
    resolved.set(attemptId, indexById.get(attemptId) ?? -1);
  }
  return resolved;
}

async function readCandidatePatch(
  experimentRoot: string,
  attemptDir: string,
  options: LoadTrialGradeRecordsOptions,
  warn: (message: string) => void,
): Promise<string> {
  const snapshot = StoredCandidateSnapshotSchema.parse(
    await readJsonUnknown(join(attemptDir, 'candidate-snapshot.json')),
  );
  const artifact = snapshot.patchArtifact;

  if (artifact.startsWith(PROTECTED_BLOB_PREFIX)) {
    const blobId = artifact.slice(PROTECTED_BLOB_PREFIX.length);
    if (options.protectedBlobStore === undefined) {
      warn(
        `attempt ${attemptDir}: candidate patch is protected blob ${blobId}; exporting placeholder (set AEL_RUN_KEY_FILE to decrypt)`,
      );
      return PROTECTED_PATCH_PLACEHOLDER;
    }
    const envelope = await readJsonUnknown(
      join(experimentRoot, 'private-blobs', `${blobId}.envelope.json`),
    );
    const plaintext = await options.protectedBlobStore.decrypt(blobId, envelope);
    return plaintext.toString('utf8');
  }

  const resolvedRoot = resolve(experimentRoot);
  const patchPath = isAbsolute(artifact) ? artifact : resolve(attemptDir, 'artifacts', artifact);
  if (!isInside(patchPath, resolvedRoot)) {
    throw new Error(`candidate patch path escapes experiment root: ${artifact}`);
  }
  return readFile(patchPath, 'utf8');
}

/**
 * Discovers gradable trials under `<experimentRoot>/attempts/<trialId>/<attemptId>/`.
 * For each trial the highest attempt index is selected; it must be `completed` and
 * have a hidden-grader `grade.json`, otherwise the trial is skipped with a warning.
 */
export async function loadTrialGradeRecords(
  experimentRoot: string,
  options: LoadTrialGradeRecordsOptions,
): Promise<TrialGradeRecord[]> {
  const warn = options.warn ?? (() => undefined);
  const attemptsRoot = join(experimentRoot, 'attempts');
  const trialIds = await listDirectories(attemptsRoot);
  if (trialIds.length === 0) {
    warn(`no attempts found under ${attemptsRoot}`);
    return [];
  }

  const records: TrialGradeRecord[] = [];
  for (const trialId of trialIds) {
    const trialDir = join(attemptsRoot, trialId);
    const attemptIds = await listDirectories(trialDir);
    const indexes = resolveAttemptIndex(trialId, attemptIds);
    const attempts: DiscoveredAttempt[] = [];
    for (const attemptId of attemptIds) {
      const attemptDir = join(trialDir, attemptId);
      const parsed = BlindedTrialStateSchema.safeParse(
        await readJsonUnknown(join(attemptDir, 'state.json')).catch(() => undefined),
      );
      if (!parsed.success) {
        warn(`trial ${trialId}: attempt ${attemptId} has no valid state.json; ignored`);
        continue;
      }
      const attemptIndex = indexes.get(attemptId) ?? -1;
      if (attemptIndex < 0) {
        warn(`trial ${trialId}: attempt ${attemptId} index could not be resolved`);
      }
      attempts.push({ attemptDir, attemptIndex, state: parsed.data });
    }
    if (attempts.length === 0) {
      continue;
    }
    attempts.sort(
      (left, right) =>
        left.attemptIndex - right.attemptIndex ||
        left.state.attemptId.localeCompare(right.state.attemptId),
    );
    const latest = attempts[attempts.length - 1];
    if (latest === undefined) {
      continue;
    }
    if (latest.state.status !== 'completed') {
      warn(`trial ${trialId}: latest attempt status is ${latest.state.status}; skipped`);
      continue;
    }
    const gradeExists = await readFile(join(latest.attemptDir, 'grade.json'), 'utf8')
      .then(() => true)
      .catch(() => false);
    if (!gradeExists) {
      warn(`trial ${trialId}: latest attempt has no grade.json; skipped`);
      continue;
    }
    const prompt = options.fixturePrompts.get(latest.state.planEntry.fixtureId);
    if (prompt === undefined) {
      warn(
        `trial ${trialId}: fixture ${latest.state.planEntry.fixtureId} not found in suite; skipped`,
      );
      continue;
    }
    let candidatePatch: string;
    try {
      candidatePatch = await readCandidatePatch(experimentRoot, latest.attemptDir, options, warn);
    } catch (error) {
      warn(
        `trial ${trialId}: candidate patch unavailable (${error instanceof Error ? error.message : 'unknown error'}); skipped`,
      );
      continue;
    }
    records.push({
      trialId,
      attemptId: latest.state.attemptId,
      fixtureId: latest.state.planEntry.fixtureId,
      armId: latest.state.planEntry.armId,
      prompt,
      candidatePatch,
    });
  }

  return records;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ExportBlindedPacketsInput {
  readonly experimentId: string;
  /** Root of the experiment; the unblinding key is written under `<root>/blinded/key/`. */
  readonly experimentRoot: string;
  readonly exportSeed: string;
  readonly trials: readonly TrialGradeRecord[];
  readonly rubricCriteria: readonly RubricCriterion[];
  /** Directory handed to raters; receives `packets.json` only. */
  readonly outDir: string;
}

export interface ExportBlindedPacketsResult {
  readonly export: BlindedExport;
  readonly key: BlindedPacketKey;
  readonly packetsPath: string;
  readonly keyPath: string;
}

export function blindedDirectory(experimentRoot: string): string {
  return join(experimentRoot, 'blinded');
}

export function packetKeyDirectory(experimentRoot: string): string {
  return join(blindedDirectory(experimentRoot), 'key');
}

function packetIdForTrial(trialId: string, exportSeed: string): string {
  return createHash('sha256').update(`${exportSeed}:${trialId}`, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Writes rater-facing `packets.json` (no arm, trial, fixture, or hidden-grader
 * outcome) and a separate `packet-key.json` that maps packets back to trials.
 * The key must never be shared with raters.
 */
export async function exportBlindedPackets(
  input: ExportBlindedPacketsInput,
): Promise<ExportBlindedPacketsResult> {
  const rng = createMulberry32(derivePrngSeed(input.exportSeed));
  const ordered = [...input.trials].sort((left, right) =>
    left.trialId.localeCompare(right.trialId),
  );
  const shuffled = shuffleDeterministic(ordered, rng);

  const exportDocument = BlindedExportSchema.parse({
    schemaVersion: 1,
    experimentId: input.experimentId,
    packets: shuffled.map((trial, index) => ({
      packetId: packetIdForTrial(trial.trialId, input.exportSeed),
      presentationOrder: index,
      prompt: trial.prompt,
      candidatePatch: trial.candidatePatch,
      rubricCriteria: input.rubricCriteria.map((criterion) => ({ ...criterion })),
    })),
  });

  const keyDocument = BlindedPacketKeySchema.parse({
    schemaVersion: 1,
    experimentId: input.experimentId,
    exportSeed: input.exportSeed,
    warning: PACKET_KEY_WARNING,
    entries: shuffled.map((trial) => ({
      packetId: packetIdForTrial(trial.trialId, input.exportSeed),
      trialId: trial.trialId,
      attemptId: trial.attemptId,
      fixtureId: trial.fixtureId,
      armId: trial.armId,
    })),
  });

  const packetsPath = join(input.outDir, 'packets.json');
  await mkdir(input.outDir, { recursive: true });
  await writeFile(packetsPath, `${JSON.stringify(exportDocument, null, 2)}\n`, 'utf8');

  // Mirror the rater-safe packets into the experiment so `grade import` can
  // validate packet ids without extra flags.
  const mirrorPath = join(blindedDirectory(input.experimentRoot), 'packets.json');
  if (resolve(mirrorPath) !== resolve(packetsPath)) {
    await writeAtomicJson(mirrorPath, exportDocument);
  }

  const keyPath = join(packetKeyDirectory(input.experimentRoot), 'packet-key.json');
  await writeAtomicJson(keyPath, keyDocument);

  return { export: exportDocument, key: keyDocument, packetsPath, keyPath };
}

// ---------------------------------------------------------------------------
// Import validation
// ---------------------------------------------------------------------------

export const DEFAULT_MINIMUM_RATERS_PER_PACKET = 2;

export interface ImportBlindedRatingsInput {
  readonly experimentId: string;
  readonly ratings: readonly BlindedRating[];
  /** Declared rater pool; every rating must come from one of these ids. */
  readonly expectedRaterIds: readonly string[];
  readonly requiredCriteriaIds: readonly string[];
  /** Packet ids from the exported `packets.json`. */
  readonly packetIds: readonly string[];
  readonly minimumRatersPerPacket?: number;
  readonly minimumKappa: number;
}

export interface ImportBlindedRatingsResult {
  /** Structural validity; when false nothing should be written and the CLI exits with EXIT_CONFIG. */
  readonly valid: boolean;
  /** Structural errors. */
  readonly messages: readonly string[];
  /** Non-fatal findings (low agreement, missing adjudication, unrated packets, ...). */
  readonly warnings: readonly string[];
  readonly importDocument: BlindedImport;
  readonly agreement: BlindedAgreement | null;
  readonly normalized: NormalizedRatings | null;
}

interface PacketRaterEntry {
  readonly raterId: string;
  readonly scores: BlindedRating['scores'];
  readonly categories: Record<string, RubricCategory>;
}

interface PacketGroup {
  readonly raters: Map<string, PacketRaterEntry>;
  readonly adjudications: BlindedAdjudication[];
}

function categoriesFor(
  scores: BlindedRating['scores'],
  criterionIds: readonly string[],
): Record<string, RubricCategory> {
  const categories: Record<string, RubricCategory> = {};
  for (const criterionId of criterionIds) {
    const entry = scores.find((score) => score.criterionId === criterionId);
    if (entry !== undefined) {
      categories[criterionId] = categorizeRubricScore(entry.score);
    }
  }
  return categories;
}

function checkScoreCompleteness(
  scores: BlindedRating['scores'],
  requiredCriteriaIds: readonly string[],
  label: string,
  messages: string[],
): void {
  const seen = new Set<string>();
  for (const score of scores) {
    if (seen.has(score.criterionId)) {
      messages.push(`${label} scores criterion ${score.criterionId} more than once`);
    }
    seen.add(score.criterionId);
    if (!requiredCriteriaIds.includes(score.criterionId)) {
      messages.push(`${label} scores unknown criterion ${score.criterionId}`);
    }
  }
  for (const requiredId of requiredCriteriaIds) {
    if (!seen.has(requiredId)) {
      messages.push(`${label} missing criterion ${requiredId}`);
    }
  }
}

interface CriterionAgreementComputation {
  readonly method: AgreementMethod;
  readonly perCriterion: CriterionAgreement[];
  readonly kappa: number | null;
  readonly raterCount: number;
}

function computeAgreement(
  packets: readonly NormalizedPacketRating[],
  criterionIds: readonly string[],
  raterIds: readonly string[],
): CriterionAgreementComputation {
  const raterCount = raterIds.length;
  const method: AgreementMethod = raterCount === 2 ? 'cohen-kappa' : 'fleiss-kappa';

  const perCriterion: CriterionAgreement[] = [];
  for (const criterionId of criterionIds) {
    const rows: string[][] = packets.map((packet) =>
      packet.raters
        .map((rater) => rater.categories[criterionId])
        .filter((category): category is RubricCategory => category !== undefined),
    );

    if (method === 'cohen-kappa') {
      const [leftRater, rightRater] = [...raterIds].sort();
      const left: string[] = [];
      const right: string[] = [];
      for (const packet of packets) {
        const leftEntry = packet.raters.find((rater) => rater.raterId === leftRater);
        const rightEntry = packet.raters.find((rater) => rater.raterId === rightRater);
        const leftCategory = leftEntry?.categories[criterionId];
        const rightCategory = rightEntry?.categories[criterionId];
        if (leftCategory !== undefined && rightCategory !== undefined) {
          left.push(leftCategory);
          right.push(rightCategory);
        }
      }
      const result = cohenKappa(left, right);
      perCriterion.push({
        criterionId,
        method,
        kappa: result.kappa,
        observedAgreement: result.observedAgreement,
        reason: result.reason,
      });
    } else {
      const result = fleissKappa(rows);
      perCriterion.push({
        criterionId,
        method,
        kappa: result.kappa,
        observedAgreement: result.observedAgreement,
        reason: result.reason,
      });
    }
  }

  // Report the most conservative criterion. Any undefined criterion makes the
  // overall kappa undefined so the gate cannot pass on partial evidence.
  const kappas = perCriterion.map((entry) => entry.kappa);
  const kappa =
    kappas.length > 0 && kappas.every((value): value is number => value !== null)
      ? Math.min(...kappas)
      : null;

  return { method, perCriterion, kappa, raterCount };
}

export function validateBlindedImport(
  input: ImportBlindedRatingsInput,
): ImportBlindedRatingsResult {
  const messages: string[] = [];
  const warnings: string[] = [];
  const minimumRaters = input.minimumRatersPerPacket ?? DEFAULT_MINIMUM_RATERS_PER_PACKET;
  const importDocument = BlindedImportSchema.parse({
    schemaVersion: 1,
    experimentId: input.experimentId,
    ratings: [...input.ratings],
  });

  const knownPacketIds = new Set(input.packetIds);
  const declaredRaters = new Set(input.expectedRaterIds);
  if (declaredRaters.size < 2) {
    messages.push('at least two rater ids are required for inter-rater agreement');
  }
  const criterionIds = [...input.requiredCriteriaIds];
  const groups = new Map<string, PacketGroup>();

  for (const rating of importDocument.ratings) {
    const label = `packet ${rating.packetId} rater ${rating.raterId}`;
    if (!knownPacketIds.has(rating.packetId)) {
      messages.push(`packet ${rating.packetId} is not part of the exported packets`);
    }
    if (!declaredRaters.has(rating.raterId)) {
      messages.push(`rater ${rating.raterId} is not in the declared rater set`);
    }
    checkScoreCompleteness(rating.scores, criterionIds, label, messages);

    const group = groups.get(rating.packetId) ?? {
      raters: new Map<string, PacketRaterEntry>(),
      adjudications: [],
    };
    if (group.raters.has(rating.raterId)) {
      messages.push(`${label} appears more than once`);
    }
    group.raters.set(rating.raterId, {
      raterId: rating.raterId,
      scores: rating.scores,
      categories: categoriesFor(rating.scores, criterionIds),
    });
    if (rating.adjudication !== undefined) {
      group.adjudications.push(rating.adjudication);
    }
    groups.set(rating.packetId, group);
  }

  const seenRaters = new Set<string>();
  for (const group of groups.values()) {
    for (const raterId of group.raters.keys()) {
      seenRaters.add(raterId);
    }
  }
  for (const expectedRaterId of input.expectedRaterIds) {
    if (!seenRaters.has(expectedRaterId)) {
      warnings.push(`declared rater ${expectedRaterId} submitted no ratings`);
    }
  }

  const packets: NormalizedPacketRating[] = [];
  let adjudicationComplete = true;
  for (const [packetId, group] of [...groups.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (group.raters.size < minimumRaters) {
      messages.push(
        `packet ${packetId} has ${String(group.raters.size)} distinct rater(s); at least ${String(minimumRaters)} required`,
      );
    }

    const raters = [...group.raters.values()].sort((left, right) =>
      left.raterId.localeCompare(right.raterId),
    );
    const disagreementCriteria = criterionIds.filter((criterionId) => {
      const categories = new Set(
        raters
          .map((rater) => rater.categories[criterionId])
          .filter((category) => category !== undefined),
      );
      return categories.size > 1;
    });
    const adjudicationRequired = disagreementCriteria.length > 0;

    let adjudication: BlindedAdjudication | null = null;
    if (group.adjudications.length > 1) {
      messages.push(`packet ${packetId} has ${String(group.adjudications.length)} adjudications`);
    }
    const [candidate] = group.adjudications;
    if (candidate !== undefined) {
      if (group.raters.has(candidate.adjudicatorId)) {
        messages.push(
          `packet ${packetId} adjudicator ${candidate.adjudicatorId} is also one of its raters`,
        );
      }
      checkScoreCompleteness(
        candidate.finalScores,
        criterionIds,
        `packet ${packetId} adjudication`,
        messages,
      );
      adjudication = candidate;
    }
    if (adjudicationRequired && adjudication === null) {
      adjudicationComplete = false;
      warnings.push(
        `packet ${packetId} needs adjudication: raters disagree on ${disagreementCriteria.join(', ')}`,
      );
    }

    let finalCategories: Record<string, RubricCategory> | null = null;
    if (adjudication !== null) {
      finalCategories = categoriesFor(adjudication.finalScores, criterionIds);
    } else if (!adjudicationRequired) {
      const [first] = raters;
      finalCategories = first === undefined ? null : { ...first.categories };
    }

    packets.push({
      packetId,
      raters: raters.map((rater) => ({
        raterId: rater.raterId,
        scores: [...rater.scores],
        categories: { ...rater.categories },
      })),
      disagreementCriteria,
      adjudicationRequired,
      adjudication,
      finalCategories,
    });
  }

  const unratedPacketIds = input.packetIds.filter((packetId) => !groups.has(packetId)).sort();
  if (unratedPacketIds.length > 0) {
    warnings.push(`${String(unratedPacketIds.length)} exported packet(s) have no ratings`);
  }

  if (messages.length > 0) {
    return {
      valid: false,
      messages,
      warnings,
      importDocument,
      agreement: null,
      normalized: null,
    };
  }

  const raterIds = [...seenRaters].sort();
  const computed = computeAgreement(packets, criterionIds, raterIds);
  const ratedPacketCount = packets.length;
  if (ratedPacketCount === 0 || computed.kappa === null) {
    const reasons = computed.perCriterion
      .filter((entry) => entry.reason !== null)
      .map((entry) => `${entry.criterionId}: ${entry.reason ?? ''}`);
    warnings.push(
      `inter-rater agreement could not be established (${reasons.length > 0 ? reasons.join('; ') : 'no rated packets'})`,
    );
  }

  const adequate = computed.kappa !== null && computed.kappa >= input.minimumKappa;
  if (computed.kappa !== null && !adequate) {
    warnings.push(
      `inter-rater agreement kappa ${computed.kappa.toFixed(3)} (${computed.method}) below minimum ${String(input.minimumKappa)}`,
    );
  }

  const agreement = BlindedAgreementSchema.parse({
    schemaVersion: 1,
    method: computed.method,
    kappa: computed.kappa,
    raterCount: computed.raterCount,
    packetCount: input.packetIds.length,
    ratedPacketCount,
    minimumKappa: input.minimumKappa,
    adequate,
    adjudicationComplete,
  });

  const normalized = NormalizedRatingsSchema.parse({
    schemaVersion: 1,
    experimentId: input.experimentId,
    raterIds,
    criterionIds,
    packets,
    perCriterion: computed.perCriterion,
    unratedPacketIds,
  });

  return {
    valid: true,
    messages,
    warnings,
    importDocument,
    agreement,
    normalized,
  };
}

// ---------------------------------------------------------------------------
// Import artifacts
// ---------------------------------------------------------------------------

export interface BlindedImportArtifactPaths {
  readonly agreementPath: string;
  readonly normalizedPath: string;
  readonly ratingsPath: string;
}

/** Writes `blinded/agreement.json`, `blinded/ratings-normalized.json`, and a raw ratings copy. */
export async function writeBlindedImportArtifacts(
  experimentRoot: string,
  result: {
    readonly importDocument: BlindedImport;
    readonly agreement: BlindedAgreement;
    readonly normalized: NormalizedRatings;
  },
): Promise<BlindedImportArtifactPaths> {
  const root = blindedDirectory(experimentRoot);
  const agreementPath = join(root, 'agreement.json');
  const normalizedPath = join(root, 'ratings-normalized.json');
  await writeAtomicJson(agreementPath, result.agreement);
  await writeAtomicJson(normalizedPath, result.normalized);
  const ratingsPath = await writeImportedRatings(experimentRoot, result.importDocument);
  return { agreementPath, normalizedPath, ratingsPath };
}

export async function writeImportedRatings(
  experimentRoot: string,
  importDocument: BlindedImport,
): Promise<string> {
  const ratingsDir = join(blindedDirectory(experimentRoot), 'ratings');
  const target = join(ratingsDir, `${randomUUID()}.json`);
  await mkdir(ratingsDir, { recursive: true });
  await writeFile(target, `${JSON.stringify(importDocument, null, 2)}\n`, 'utf8');
  return target;
}
