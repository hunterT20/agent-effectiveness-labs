import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { computeAttemptId, parseBlindedAgreement, parseBlindedExport } from '@ael/core';

import { DEFAULT_RUBRIC, gradeExportCommand, gradeImportCommand } from '../src/commands/grade.js';
import { EXIT_CONFIG, EXIT_OK } from '../src/exitCodes.js';

const suitePath = join(import.meta.dirname, '../../../examples/minimal/suite.yaml');

function readJson(path: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return parsed;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function capture(): {
  readonly context: { stdout: (message: string) => void; stderr: (message: string) => void };
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    context: {
      stdout: (message: string) => {
        stdout.push(message);
      },
      stderr: (message: string) => {
        stderr.push(message);
      },
    },
    stdout,
    stderr,
  };
}

function rubricScores(score: number): { criterionId: string; score: number }[] {
  return DEFAULT_RUBRIC.map((entry) => ({ criterionId: entry.id, score }));
}

function writeCompletedTrial(
  experimentRoot: string,
  trialId: string,
  fixtureId: string,
  armId: string,
  patch: string,
): void {
  const attemptId = computeAttemptId({ trialId, attemptIndex: 0 });
  const attemptDir = join(experimentRoot, 'attempts', trialId, attemptId);
  mkdirSync(join(attemptDir, 'artifacts'), { recursive: true });
  writeJson(join(attemptDir, 'state.json'), {
    schemaVersion: 1,
    trialId,
    attemptId,
    status: 'completed',
    planEntry: {
      trialIndex: 0,
      blockIndex: 0,
      fixtureId,
      armId,
      repeatIndex: 0,
    },
  });
  writeFileSync(join(attemptDir, 'artifacts', 'candidate.patch'), patch, 'utf8');
  writeJson(join(attemptDir, 'candidate-snapshot.json'), {
    schemaVersion: 1,
    baseFingerprint: 'base',
    finalFingerprint: 'final',
    patchSha256: 'patch',
    fileManifestSha256: 'manifest',
    changedFiles: [{ path: 'src/answer.txt', changeType: 'modified' }],
    patchArtifact: 'candidate.patch',
    untrackedArchiveArtifact: null,
    overlayIntegrity: 'unchanged',
  });
  writeJson(join(attemptDir, 'grade.json'), {
    schemaVersion: 1,
    status: 'verified_success',
  });
}

async function exportTwoTrials(experimentRoot: string): Promise<string> {
  writeCompletedTrial(experimentRoot, 'trial-a', 'fix-a', 'arm-control-secret', 'patch-a');
  writeCompletedTrial(experimentRoot, 'trial-b', 'fix-b', 'arm-treatment-secret', 'patch-b');
  const outDir = join(experimentRoot, 'rater-packets');
  const logs = capture();
  const code = await gradeExportCommand(experimentRoot, outDir, logs.context, 'seed-1', suitePath);
  expect(code).toBe(EXIT_OK);
  return outDir;
}

describe('grade export', () => {
  it('exits EXIT_CONFIG when --suite is missing', async () => {
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-grade-export-nosuite-'));
    const logs = capture();
    const code = await gradeExportCommand(
      experimentRoot,
      join(experimentRoot, 'out'),
      logs.context,
    );
    expect(code).toBe(EXIT_CONFIG);
    expect(logs.stderr.join('')).toContain('--suite');
  });

  it('exits EXIT_CONFIG when no graded trials exist', async () => {
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-grade-export-empty-'));
    const logs = capture();
    const code = await gradeExportCommand(
      experimentRoot,
      join(experimentRoot, 'out'),
      logs.context,
      'seed-1',
      suitePath,
    );
    expect(code).toBe(EXIT_CONFIG);
    expect(logs.stderr.join('')).toContain('no graded trials');
  });

  it('exports blinded packets without arm identity', async () => {
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-grade-export-ok-'));
    const outDir = await exportTwoTrials(experimentRoot);
    const packets = parseBlindedExport(readJson(join(outDir, 'packets.json')));
    expect(packets.packets).toHaveLength(2);
    expect(JSON.stringify(packets)).not.toContain('arm-control-secret');
    expect(JSON.stringify(packets)).not.toContain('verified_success');
    for (const packet of packets.packets) {
      expect(packet.prompt.length).toBeGreaterThan(0);
      expect(packet.candidatePatch.length).toBeGreaterThan(0);
    }
  });
});

describe('grade import', () => {
  it('exits EXIT_CONFIG for invalid ratings or missing packets', async () => {
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-grade-import-bad-'));
    const logs = capture();
    const ratingsPath = join(experimentRoot, 'ratings.json');
    writeJson(ratingsPath, { nope: true });
    const invalid = await gradeImportCommand(experimentRoot, ratingsPath, logs.context, {
      raterIds: 'r1,r2',
    });
    expect(invalid).toBe(EXIT_CONFIG);

    writeJson(ratingsPath, {
      schemaVersion: 1,
      ratings: [
        {
          packetId: 'p1',
          raterId: 'r1',
          scores: rubricScores(4),
        },
      ],
    });
    const missingPackets = await gradeImportCommand(experimentRoot, ratingsPath, logs.context, {
      raterIds: 'r1,r2',
    });
    expect(missingPackets).toBe(EXIT_CONFIG);
  });

  it('exits EXIT_CONFIG for structural rating errors', async () => {
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-grade-import-struct-'));
    const outDir = await exportTwoTrials(experimentRoot);
    const packets = parseBlindedExport(readJson(join(outDir, 'packets.json')));
    const firstPacket = packets.packets[0];
    if (firstPacket === undefined) {
      throw new Error('expected exported packets');
    }
    const ratingsPath = join(experimentRoot, 'ratings.json');
    writeJson(ratingsPath, {
      schemaVersion: 1,
      ratings: [
        {
          packetId: firstPacket.packetId,
          raterId: 'r1',
          scores: rubricScores(4),
        },
      ],
    });
    const logs = capture();
    const code = await gradeImportCommand(experimentRoot, ratingsPath, logs.context, {
      raterIds: 'r1,r2',
    });
    expect(code).toBe(EXIT_CONFIG);
    expect(logs.stderr.join('')).toContain('at least 2');
  });

  it('writes agreement.json and exits EXIT_OK when kappa is adequate', async () => {
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-grade-import-ok-'));
    const outDir = await exportTwoTrials(experimentRoot);
    const packets = parseBlindedExport(readJson(join(outDir, 'packets.json')));
    const ratingsPath = join(experimentRoot, 'ratings.json');
    writeJson(ratingsPath, {
      schemaVersion: 1,
      ratings: packets.packets.flatMap((packet) => [
        { packetId: packet.packetId, raterId: 'r1', scores: rubricScores(4) },
        { packetId: packet.packetId, raterId: 'r2', scores: rubricScores(5) },
      ]),
    });
    const logs = capture();
    const code = await gradeImportCommand(experimentRoot, ratingsPath, logs.context, {
      raterIds: 'r1,r2',
    });
    expect(code).toBe(EXIT_OK);
    const agreement = parseBlindedAgreement(
      readJson(join(experimentRoot, 'blinded', 'agreement.json')),
    );
    expect(agreement.schemaVersion).toBe(1);
    expect(agreement.method).toBe('cohen-kappa');
    expect(agreement.kappa).toBe(1);
    expect(agreement.adequate).toBe(true);
    expect(agreement.adjudicationComplete).toBe(true);
    expect(logs.stdout.join('')).toContain('agreement written');
  });

  it('exits EXIT_OK when kappa is below the minimum so the gate can flag INSUFFICIENT_DATA', async () => {
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-grade-import-low-'));
    const outDir = await exportTwoTrials(experimentRoot);
    const packets = parseBlindedExport(readJson(join(outDir, 'packets.json')));
    const ratingsPath = join(experimentRoot, 'ratings.json');
    writeJson(ratingsPath, {
      schemaVersion: 1,
      ratings: packets.packets.flatMap((packet) => [
        { packetId: packet.packetId, raterId: 'r1', scores: rubricScores(5) },
        { packetId: packet.packetId, raterId: 'r2', scores: rubricScores(0) },
      ]),
    });
    const logs = capture();
    const code = await gradeImportCommand(experimentRoot, ratingsPath, logs.context, {
      raterIds: 'r1,r2',
    });
    expect(code).toBe(EXIT_OK);
    const agreement = parseBlindedAgreement(
      readJson(join(experimentRoot, 'blinded', 'agreement.json')),
    );
    expect(agreement.kappa).toBe(0);
    expect(agreement.adequate).toBe(false);
    expect(agreement.adjudicationComplete).toBe(false);
    expect(logs.stderr.join('')).toContain('below minimum');
  });
});
