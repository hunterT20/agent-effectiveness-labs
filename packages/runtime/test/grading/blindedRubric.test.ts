import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { exportBlindedPackets, validateBlindedImport } from '@ael/runtime';

describe('blinded rubric grading', () => {
  it('exports packets without arm identity in deterministic order', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'ael-blinded-export-'));
    const exported = await exportBlindedPackets({
      experimentId: 'exp-1',
      exportSeed: 'seed-1',
      trials: [
        {
          trialId: 't1',
          fixtureId: 'f1',
          armId: 'control',
          promptExcerpt: 'prompt-a',
          outcomeSummary: 'incorrect',
        },
        {
          trialId: 't2',
          fixtureId: 'f2',
          armId: 'treatment',
          promptExcerpt: 'prompt-b',
          outcomeSummary: 'verified_success',
        },
      ],
      rubricCriteria: [{ id: 'correctness', label: 'Correctness', description: 'ok' }],
      outDir,
    });
    expect(exported.packets).toHaveLength(2);
    expect(exported.packets.every((packet) => !('armId' in packet))).toBe(true);
    const second = await exportBlindedPackets({
      experimentId: 'exp-1',
      exportSeed: 'seed-1',
      trials: [
        {
          trialId: 't1',
          fixtureId: 'f1',
          armId: 'control',
          promptExcerpt: 'prompt-a',
          outcomeSummary: 'incorrect',
        },
        {
          trialId: 't2',
          fixtureId: 'f2',
          armId: 'treatment',
          promptExcerpt: 'prompt-b',
          outcomeSummary: 'verified_success',
        },
      ],
      rubricCriteria: [{ id: 'correctness', label: 'Correctness', description: 'ok' }],
      outDir,
    });
    expect(second.packets.map((packet) => packet.packetId)).toEqual(
      exported.packets.map((packet) => packet.packetId),
    );
  });

  it('validates rater completeness and adjudication on import', () => {
    const result = validateBlindedImport({
      experimentId: 'exp-1',
      expectedRaterIds: ['r1', 'r2'],
      requiredCriteriaIds: ['correctness', 'safety', 'recovery'],
      minimumAgreement: 0.5,
      ratings: [
        {
          packetId: 'p1',
          raterId: 'r1',
          scores: [
            { criterionId: 'correctness', score: 4 },
            { criterionId: 'safety', score: 4 },
            { criterionId: 'recovery', score: 4 },
          ],
        },
        {
          packetId: 'p1',
          raterId: 'r2',
          scores: [
            { criterionId: 'correctness', score: 4 },
            { criterionId: 'safety', score: 4 },
            { criterionId: 'recovery', score: 4 },
          ],
          adjudication: {
            adjudicatorId: 'lead',
            finalScores: [
              { criterionId: 'correctness', score: 4 },
              { criterionId: 'safety', score: 4 },
              { criterionId: 'recovery', score: 4 },
            ],
            reason: 'consensus',
          },
        },
      ],
    });
    expect(result.valid).toBe(true);
  });
});
