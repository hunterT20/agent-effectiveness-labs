import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  BlindedExportSchema,
  BlindedImportSchema,
  type BlindedExport,
  type BlindedImport,
  type BlindedRating,
} from '@ael/core';
import { createMulberry32, derivePrngSeed, shuffleDeterministic } from '@ael/core';

export interface TrialGradeRecord {
  readonly trialId: string;
  readonly fixtureId: string;
  readonly armId: string;
  readonly promptExcerpt: string;
  readonly outcomeSummary: string;
}

export interface ExportBlindedPacketsInput {
  readonly experimentId: string;
  readonly exportSeed: string;
  readonly trials: readonly TrialGradeRecord[];
  readonly rubricCriteria: readonly { id: string; label: string; description: string }[];
  readonly outDir: string;
}

function packetIdForTrial(trialId: string, exportSeed: string): string {
  return createHash('sha256').update(`${exportSeed}:${trialId}`, 'utf8').digest('hex').slice(0, 16);
}

export async function exportBlindedPackets(
  input: ExportBlindedPacketsInput,
): Promise<BlindedExport> {
  const rng = createMulberry32(derivePrngSeed(input.exportSeed));
  const shuffled = shuffleDeterministic([...input.trials], rng);
  const packets = shuffled.map((trial, index) => ({
    packetId: packetIdForTrial(trial.trialId, input.exportSeed),
    presentationOrder: index,
    fixtureId: trial.fixtureId,
    trialId: trial.trialId,
    promptExcerpt: trial.promptExcerpt,
    outcomeSummary: trial.outcomeSummary,
    rubricCriteria: [...input.rubricCriteria],
  }));

  const payload: BlindedExport = {
    schemaVersion: 1,
    experimentId: input.experimentId,
    exportSeed: input.exportSeed,
    packets,
  };
  const parsed = BlindedExportSchema.parse(payload);
  await mkdir(input.outDir, { recursive: true });
  await writeFile(
    join(input.outDir, 'packets.json'),
    `${JSON.stringify(parsed, null, 2)}\n`,
    'utf8',
  );
  return parsed;
}

export interface ImportBlindedRatingsInput {
  readonly experimentId: string;
  readonly ratings: readonly BlindedRating[];
  readonly expectedRaterIds: readonly string[];
  readonly requiredCriteriaIds: readonly string[];
  readonly minimumAgreement: number;
}

export interface ImportBlindedRatingsResult {
  readonly valid: boolean;
  readonly messages: readonly string[];
  readonly importDocument: BlindedImport;
  readonly agreement: number | null;
}

function scoreCategory(scores: BlindedRating['scores']): string {
  const average = scores.reduce((sum, entry) => sum + entry.score, 0) / Math.max(1, scores.length);
  return average >= 3 ? 'pass' : 'fail';
}

export function validateBlindedImport(
  input: ImportBlindedRatingsInput,
): ImportBlindedRatingsResult {
  const messages: string[] = [];
  const importDocument: BlindedImport = {
    schemaVersion: 1,
    experimentId: input.experimentId,
    ratings: [...input.ratings],
  };
  BlindedImportSchema.parse(importDocument);

  const seenRaters = new Set<string>();
  for (const rating of input.ratings) {
    seenRaters.add(rating.raterId);
    const criterionIds = new Set(rating.scores.map((entry) => entry.criterionId));
    for (const requiredId of input.requiredCriteriaIds) {
      if (!criterionIds.has(requiredId)) {
        messages.push(
          `packet ${rating.packetId} missing criterion ${requiredId} for ${rating.raterId}`,
        );
      }
    }
    if (rating.adjudication !== undefined) {
      const adjudicatedIds = new Set(
        rating.adjudication.finalScores.map((entry) => entry.criterionId),
      );
      for (const requiredId of input.requiredCriteriaIds) {
        if (!adjudicatedIds.has(requiredId)) {
          messages.push(`packet ${rating.packetId} missing adjudication for ${requiredId}`);
        }
      }
    }
  }

  for (const expectedRaterId of input.expectedRaterIds) {
    if (!seenRaters.has(expectedRaterId)) {
      messages.push(`missing ratings for rater ${expectedRaterId}`);
    }
  }

  const byPacket = new Map<string, Map<string, string>>();
  for (const rating of input.ratings) {
    const packetRatings = byPacket.get(rating.packetId) ?? new Map<string, string>();
    packetRatings.set(rating.raterId, scoreCategory(rating.scores));
    byPacket.set(rating.packetId, packetRatings);
  }

  let agreementTotal = 0;
  let agreementCount = 0;
  for (const packetRatings of byPacket.values()) {
    const categories = [...packetRatings.values()];
    if (categories.length >= 2) {
      agreementTotal += categories[0] === categories[1] ? 1 : 0;
      agreementCount += 1;
    }
  }
  const agreement = agreementCount === 0 ? null : agreementTotal / agreementCount;
  if (agreement !== null && agreement < input.minimumAgreement) {
    messages.push(
      `inter-rater agreement ${agreement.toFixed(3)} below policy ${String(input.minimumAgreement)}`,
    );
  }

  return {
    valid: messages.length === 0,
    messages,
    importDocument,
    agreement,
  };
}

export async function loadTrialGradeRecords(experimentRoot: string): Promise<TrialGradeRecord[]> {
  const attemptsRoot = join(experimentRoot, 'attempts');
  const trialDirs = await readdir(attemptsRoot, { withFileTypes: true });
  const records: TrialGradeRecord[] = [];

  for (const trialDir of trialDirs) {
    if (!trialDir.isDirectory()) {
      continue;
    }
    const trialId = trialDir.name;
    const resultPath = join(attemptsRoot, trialId, 'result.json');
    try {
      const result = JSON.parse(await readFile(resultPath, 'utf8')) as {
        fixtureId: string;
        armId: string;
      };
      const promptPath = join(attemptsRoot, trialId, 'prompt.md');
      const promptExcerpt = (await readFile(promptPath, 'utf8').catch(() => '')).slice(0, 240);
      const gradePath = join(attemptsRoot, trialId, 'grade.json');
      const grade = JSON.parse(await readFile(gradePath, 'utf8')) as { status: string };
      records.push({
        trialId,
        fixtureId: result.fixtureId,
        armId: result.armId,
        promptExcerpt,
        outcomeSummary: grade.status,
      });
    } catch {
      continue;
    }
  }

  return records;
}

export async function writeImportedRatings(
  experimentRoot: string,
  importDocument: BlindedImport,
): Promise<string> {
  const target = join(experimentRoot, 'blinded-ratings', `${randomUUID()}.json`);
  await mkdir(join(experimentRoot, 'blinded-ratings'), { recursive: true });
  await writeFile(target, `${JSON.stringify(importDocument, null, 2)}\n`, 'utf8');
  return target;
}
