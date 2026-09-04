import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BlindedPacketKeySchema,
  NormalizedRatingsSchema,
  computeAttemptId,
  parseBlindedAgreement,
  parseBlindedExport,
  type BlindedRating,
} from '@ael/core';
import {
  PROTECTED_PATCH_PLACEHOLDER,
  ProtectedBlobStore,
  blindedDirectory,
  createRunKeySourceFromHex,
  exportBlindedPackets,
  loadTrialGradeRecords,
  packetKeyDirectory,
  validateBlindedImport,
  writeBlindedImportArtifacts,
} from '@ael/runtime';

const RUBRIC = [{ id: 'correctness', label: 'Correctness', description: 'ok' }] as const;
const RUN_KEY_HEX = 'ab'.repeat(32);

function readJson(path: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return parsed;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function scores(value: number): BlindedRating['scores'] {
  return [{ criterionId: 'correctness', score: value }];
}

function rating(
  packetId: string,
  raterId: string,
  score: number,
  adjudication?: BlindedRating['adjudication'],
): BlindedRating {
  return {
    packetId,
    raterId,
    scores: scores(score),
    ...(adjudication !== undefined ? { adjudication } : {}),
  };
}

function writeSnapshot(attemptDir: string, patchArtifact: string): void {
  writeJson(join(attemptDir, 'candidate-snapshot.json'), {
    schemaVersion: 1,
    baseFingerprint: 'base',
    finalFingerprint: 'final',
    patchSha256: 'patch',
    fileManifestSha256: 'manifest',
    changedFiles: [{ path: 'src/answer.txt', changeType: 'modified' }],
    patchArtifact,
    untrackedArchiveArtifact: null,
    overlayIntegrity: 'unchanged',
  });
}

function writeAttempt(input: {
  readonly experimentRoot: string;
  readonly trialId: string;
  readonly attemptIndex: number;
  readonly status: string;
  readonly fixtureId: string;
  readonly armId: string;
  readonly patch: string;
  readonly omitGrade?: boolean;
  readonly patchArtifact?: string;
}): string {
  const attemptId = computeAttemptId({ trialId: input.trialId, attemptIndex: input.attemptIndex });
  const attemptDir = join(input.experimentRoot, 'attempts', input.trialId, attemptId);
  mkdirSync(join(attemptDir, 'artifacts'), { recursive: true });
  writeJson(join(attemptDir, 'state.json'), {
    schemaVersion: 1,
    trialId: input.trialId,
    attemptId,
    status: input.status,
    planEntry: {
      trialIndex: 0,
      blockIndex: 0,
      fixtureId: input.fixtureId,
      armId: input.armId,
      repeatIndex: 0,
    },
  });
  writeFileSync(join(attemptDir, 'artifacts', 'candidate.patch'), input.patch, 'utf8');
  writeSnapshot(attemptDir, input.patchArtifact ?? 'candidate.patch');
  if (input.omitGrade !== true) {
    writeJson(join(attemptDir, 'grade.json'), {
      schemaVersion: 1,
      status: 'verified_success',
    });
  }
  return attemptId;
}

describe('loadTrialGradeRecords', () => {
  it('loads the highest completed attempt and skips incomplete latest attempts', async () => {
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-blinded-load-'));
    writeAttempt({
      experimentRoot,
      trialId: 'trial-keep',
      attemptIndex: 0,
      status: 'completed',
      fixtureId: 'fix-a',
      armId: 'arm-control-secret',
      patch: 'old-patch',
    });
    writeAttempt({
      experimentRoot,
      trialId: 'trial-keep',
      attemptIndex: 1,
      status: 'completed',
      fixtureId: 'fix-a',
      armId: 'arm-control-secret',
      patch: 'latest-patch',
    });
    writeAttempt({
      experimentRoot,
      trialId: 'trial-skip-running',
      attemptIndex: 0,
      status: 'completed',
      fixtureId: 'fix-b',
      armId: 'arm-treatment-secret',
      patch: 'should-not-export',
    });
    writeAttempt({
      experimentRoot,
      trialId: 'trial-skip-running',
      attemptIndex: 1,
      status: 'running',
      fixtureId: 'fix-b',
      armId: 'arm-treatment-secret',
      patch: 'in-progress',
      omitGrade: true,
    });
    writeAttempt({
      experimentRoot,
      trialId: 'trial-skip-ungraded',
      attemptIndex: 0,
      status: 'completed',
      fixtureId: 'fix-a',
      armId: 'arm-control-secret',
      patch: 'no-grade',
      omitGrade: true,
    });

    const warnings: string[] = [];
    const records = await loadTrialGradeRecords(experimentRoot, {
      fixturePrompts: new Map([
        ['fix-a', 'prompt-for-a'],
        ['fix-b', 'prompt-for-b'],
      ]),
      warn: (message) => {
        warnings.push(message);
      },
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.trialId).toBe('trial-keep');
    expect(records[0]?.candidatePatch).toBe('latest-patch');
    expect(records[0]?.prompt).toBe('prompt-for-a');
    expect(warnings.some((message) => message.includes('trial-skip-running'))).toBe(true);
    expect(warnings.some((message) => message.includes('trial-skip-ungraded'))).toBe(true);
  });

  it('exports a placeholder when the candidate patch is a protected blob without a run key', async () => {
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-blinded-blob-'));
    const store = new ProtectedBlobStore(experimentRoot, createRunKeySourceFromHex(RUN_KEY_HEX));
    const stored = await store.encryptAndStore(Buffer.from('secret-candidate-patch', 'utf8'));
    writeAttempt({
      experimentRoot,
      trialId: 'trial-protected',
      attemptIndex: 0,
      status: 'completed',
      fixtureId: 'fix-a',
      armId: 'arm-control-secret',
      patch: 'plaintext-should-not-be-used',
      patchArtifact: `protected-blobs/${stored.blobId}`,
    });

    const warnings: string[] = [];
    const withoutKey = await loadTrialGradeRecords(experimentRoot, {
      fixturePrompts: new Map([['fix-a', 'prompt-for-a']]),
      warn: (message) => {
        warnings.push(message);
      },
    });
    expect(withoutKey[0]?.candidatePatch).toBe(PROTECTED_PATCH_PLACEHOLDER);
    expect(warnings.some((message) => message.includes('AEL_RUN_KEY_FILE'))).toBe(true);

    const withKey = await loadTrialGradeRecords(experimentRoot, {
      fixturePrompts: new Map([['fix-a', 'prompt-for-a']]),
      protectedBlobStore: store,
    });
    expect(withKey[0]?.candidatePatch).toBe('secret-candidate-patch');
  });
});

describe('exportBlindedPackets', () => {
  it('writes arm-free packets and a separate unblinding key in deterministic order', async () => {
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-blinded-export-'));
    const outDir = join(experimentRoot, 'rater-packets');
    const trials = [
      {
        trialId: 't2',
        attemptId: 'attempt-t2',
        fixtureId: 'f2',
        armId: 'arm-treatment-secret',
        prompt: 'prompt-b',
        candidatePatch: 'patch-b',
      },
      {
        trialId: 't1',
        attemptId: 'attempt-t1',
        fixtureId: 'f1',
        armId: 'arm-control-secret',
        prompt: 'prompt-a',
        candidatePatch: 'patch-a',
      },
    ];

    const first = await exportBlindedPackets({
      experimentId: 'exp-1',
      experimentRoot,
      exportSeed: 'seed-1',
      trials,
      rubricCriteria: RUBRIC,
      outDir,
    });
    const reversed = await exportBlindedPackets({
      experimentId: 'exp-1',
      experimentRoot,
      exportSeed: 'seed-1',
      trials: [...trials].reverse(),
      rubricCriteria: RUBRIC,
      outDir,
    });

    const packets = parseBlindedExport(readJson(first.packetsPath));
    expect(packets.packets).toHaveLength(2);
    expect(packets.packets.map((packet) => packet.packetId)).toEqual(
      reversed.export.packets.map((packet) => packet.packetId),
    );
    for (const packet of packets.packets) {
      expect(packet).not.toHaveProperty('armId');
      expect(packet).not.toHaveProperty('trialId');
      expect(packet).not.toHaveProperty('fixtureId');
      expect(packet).not.toHaveProperty('outcomeSummary');
      expect(packet).not.toHaveProperty('status');
    }
    expect(JSON.stringify(packets)).not.toContain('arm-control-secret');
    expect(JSON.stringify(packets)).not.toContain('arm-treatment-secret');
    expect(JSON.stringify(packets)).not.toContain('verified_success');
    expect(readdirSync(outDir)).toEqual(['packets.json']);

    const keyPath = join(packetKeyDirectory(experimentRoot), 'packet-key.json');
    expect(existsSync(keyPath)).toBe(true);
    const key = BlindedPacketKeySchema.parse(readJson(keyPath));
    expect(key.entries.some((entry) => entry.armId === 'arm-control-secret')).toBe(true);
    expect(existsSync(join(blindedDirectory(experimentRoot), 'packets.json'))).toBe(true);
  });
});

describe('validateBlindedImport', () => {
  const packetIds = ['p1', 'p2'];

  it('accepts two agreeing raters and records Cohen kappa', () => {
    const result = validateBlindedImport({
      experimentId: 'exp-1',
      expectedRaterIds: ['r1', 'r2'],
      requiredCriteriaIds: ['correctness'],
      packetIds,
      minimumKappa: 0.6,
      ratings: [
        rating('p1', 'r1', 4),
        rating('p1', 'r2', 5),
        rating('p2', 'r1', 1),
        rating('p2', 'r2', 0),
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.agreement).not.toBeNull();
    expect(result.agreement?.method).toBe('cohen-kappa');
    expect(result.agreement?.kappa).toBe(1);
    expect(result.agreement?.adequate).toBe(true);
    expect(result.agreement?.adjudicationComplete).toBe(true);
    expect(result.agreement?.schemaVersion).toBe(1);
  });

  it('uses Fleiss kappa for three raters', () => {
    const result = validateBlindedImport({
      experimentId: 'exp-1',
      expectedRaterIds: ['r1', 'r2', 'r3'],
      requiredCriteriaIds: ['correctness'],
      packetIds: ['p1'],
      minimumKappa: 0.6,
      ratings: [rating('p1', 'r1', 4), rating('p1', 'r2', 4), rating('p1', 'r3', 5)],
    });
    expect(result.valid).toBe(true);
    expect(result.agreement?.method).toBe('fleiss-kappa');
    expect(result.agreement?.kappa).toBe(1);
    expect(result.agreement?.raterCount).toBe(3);
  });

  it('requires a known packet, two raters, complete fields, and a non-rater adjudicator', () => {
    const unknownPacket = validateBlindedImport({
      experimentId: 'exp-1',
      expectedRaterIds: ['r1', 'r2'],
      requiredCriteriaIds: ['correctness'],
      packetIds,
      minimumKappa: 0.6,
      ratings: [rating('missing', 'r1', 4), rating('missing', 'r2', 4)],
    });
    expect(unknownPacket.valid).toBe(false);
    expect(unknownPacket.agreement).toBeNull();
    expect(unknownPacket.messages.some((message) => message.includes('not part of'))).toBe(true);

    const oneRater = validateBlindedImport({
      experimentId: 'exp-1',
      expectedRaterIds: ['r1', 'r2'],
      requiredCriteriaIds: ['correctness'],
      packetIds,
      minimumKappa: 0.6,
      ratings: [rating('p1', 'r1', 4)],
    });
    expect(oneRater.valid).toBe(false);
    expect(oneRater.messages.some((message) => message.includes('at least 2'))).toBe(true);

    const missingField = validateBlindedImport({
      experimentId: 'exp-1',
      expectedRaterIds: ['r1', 'r2'],
      requiredCriteriaIds: ['correctness', 'safety'],
      packetIds,
      minimumKappa: 0.6,
      ratings: [rating('p1', 'r1', 4), rating('p1', 'r2', 4)],
    });
    expect(missingField.valid).toBe(false);
    expect(missingField.messages.some((message) => message.includes('missing criterion'))).toBe(
      true,
    );

    const raterAdjudicator = validateBlindedImport({
      experimentId: 'exp-1',
      expectedRaterIds: ['r1', 'r2'],
      requiredCriteriaIds: ['correctness'],
      packetIds: ['p1'],
      minimumKappa: 0.6,
      ratings: [
        rating('p1', 'r1', 4),
        rating('p1', 'r2', 1, {
          adjudicatorId: 'r1',
          finalScores: scores(4),
          reason: 'override',
        }),
      ],
    });
    expect(raterAdjudicator.valid).toBe(false);
    expect(
      raterAdjudicator.messages.some((message) => message.includes('also one of its raters')),
    ).toBe(true);
  });

  it('requires adjudication on disagreement but still records incomplete agreement', () => {
    const result = validateBlindedImport({
      experimentId: 'exp-1',
      expectedRaterIds: ['r1', 'r2'],
      requiredCriteriaIds: ['correctness'],
      packetIds: ['p1'],
      minimumKappa: 0.6,
      ratings: [rating('p1', 'r1', 5), rating('p1', 'r2', 0)],
    });
    expect(result.valid).toBe(true);
    expect(result.agreement).not.toBeNull();
    expect(result.agreement?.adjudicationComplete).toBe(false);
    expect(result.warnings.some((warning) => warning.includes('needs adjudication'))).toBe(true);

    const adjudicated = validateBlindedImport({
      experimentId: 'exp-1',
      expectedRaterIds: ['r1', 'r2'],
      requiredCriteriaIds: ['correctness'],
      packetIds: ['p1'],
      minimumKappa: 0.6,
      ratings: [
        rating('p1', 'r1', 5),
        rating('p1', 'r2', 0, {
          adjudicatorId: 'lead',
          finalScores: scores(4),
          reason: 'majority after discussion',
        }),
      ],
    });
    expect(adjudicated.valid).toBe(true);
    expect(adjudicated.agreement?.adjudicationComplete).toBe(true);
  });

  it('does not treat undefined kappa as adequate', () => {
    const result = validateBlindedImport({
      experimentId: 'exp-1',
      expectedRaterIds: ['r1', 'r2', 'r3'],
      requiredCriteriaIds: ['correctness'],
      packetIds: ['p1', 'p2'],
      minimumKappa: 0.6,
      ratings: [
        rating('p1', 'r1', 4),
        rating('p1', 'r2', 4),
        rating('p1', 'r3', 4),
        rating('p2', 'r1', 1),
        rating('p2', 'r2', 1),
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.agreement).not.toBeNull();
    expect(result.agreement?.method).toBe('fleiss-kappa');
    expect(result.agreement?.kappa).toBeNull();
    expect(result.agreement?.adequate).toBe(false);
    expect(result.warnings.some((warning) => warning.includes('could not be established'))).toBe(
      true,
    );
  });

  it('writes agreement.json and ratings-normalized.json', async () => {
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-blinded-import-'));
    const result = validateBlindedImport({
      experimentId: 'exp-1',
      expectedRaterIds: ['r1', 'r2'],
      requiredCriteriaIds: ['correctness'],
      packetIds: ['p1'],
      minimumKappa: 0.6,
      ratings: [rating('p1', 'r1', 4), rating('p1', 'r2', 4)],
    });
    expect(result.agreement).not.toBeNull();
    expect(result.normalized).not.toBeNull();
    if (result.agreement === null || result.normalized === null) {
      throw new Error('expected agreement artifacts');
    }
    const paths = await writeBlindedImportArtifacts(experimentRoot, {
      importDocument: result.importDocument,
      agreement: result.agreement,
      normalized: result.normalized,
    });
    const agreement = parseBlindedAgreement(readJson(paths.agreementPath));
    expect(agreement.schemaVersion).toBe(1);
    expect(agreement.adequate).toBe(true);
    const normalized = NormalizedRatingsSchema.parse(readJson(paths.normalizedPath));
    expect(normalized.packets).toHaveLength(1);
  });
});
