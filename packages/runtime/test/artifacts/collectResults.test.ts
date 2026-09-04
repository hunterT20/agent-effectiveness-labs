import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeAttemptId } from '@ael/core';
import { collectExperimentResults } from '@ael/runtime';
import { describe, expect, it } from 'vitest';

import { writeSyntheticExperiment } from './syntheticExperiment.js';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

describe('collectExperimentResults', () => {
  it('collects 3 fixtures × 2 arms × 2 repeats, latest attempt, infra failure, missing pair', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ael-collect-'));
    const plan = writeSyntheticExperiment(root);
    const collected = await collectExperimentResults(root);

    expect(collected.trialPlan.fingerprint).toBe(plan.fingerprint);
    expect(collected.preregistration?.randomSeed).toBe('synth-seed');
    expect(collected.trials).toHaveLength(11);
    expect(collected.missingPlanEntries).toHaveLength(1);
    expect(collected.missingPlanEntries[0]).toMatchObject({
      fixtureId: 'claims-done',
      armId: 'treatment',
      repeatIndex: 1,
    });
    expect(collected.blindedAgreement).toBeNull();
    expect(collected.doctor).toBeNull();

    const retried = collected.trials.find(
      (trial) => trial.fixtureId === 'bug-fix' && trial.armId === 'baseline' && trial.repeatIndex === 0,
    );
    expect(retried?.attemptIndex).toBe(1);
    expect(retried?.status).toBe('completed');
    expect(retried?.gradeStatus).toBe('incorrect');
    expect(retried?.verifiedSuccess).toBe(false);
    expect(retried?.durationMs).toBe(100);

    const infra = collected.trials.find(
      (trial) =>
        trial.fixtureId === 'regression' && trial.armId === 'baseline' && trial.repeatIndex === 0,
    );
    expect(infra?.infrastructureFailed).toBe(true);
    expect(infra?.gradeStatus).toBe('not_graded');
    expect(infra?.durationMs).toBeNull();

    const treatmentSuccess = collected.trials.filter(
      (trial) => trial.armId === 'treatment' && trial.verifiedSuccess,
    );
    expect(treatmentSuccess).toHaveLength(4);
  });

  it('reads optional blinded agreement and doctor artifacts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ael-collect-opt-'));
    writeSyntheticExperiment(root);
    mkdirSync(join(root, 'blinded'), { recursive: true });
    writeJson(join(root, 'blinded', 'agreement.json'), {
      schemaVersion: 1,
      method: 'cohen-kappa',
      kappa: 0.7,
      raterCount: 2,
      packetCount: 4,
      ratedPacketCount: 4,
      minimumKappa: 0.6,
      adequate: true,
      adjudicationComplete: true,
    });
    writeJson(join(root, 'doctor.json'), {
      schemaVersion: 1,
      observedCapabilities: {
        level: 'directory-only',
        filesystemEnforced: false,
        networkPolicyEnforced: false,
        processTreeEnforced: false,
        hiddenGraderProtected: false,
        externalArtifactsProtected: false,
      },
      supported: false,
      messages: ['synthetic only'],
    });

    const collected = await collectExperimentResults(root);
    expect(collected.blindedAgreement).toMatchObject({
      evidencePath: 'blinded/agreement.json',
      method: 'cohen-kappa',
      kappa: 0.7,
      adequate: true,
    });
    expect(collected.doctor?.evidencePath).toBe('doctor.json');
    expect(collected.doctor?.observedCapabilities.level).toBe('directory-only');
  });

  it('records unresolved attempts when planEntry is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ael-collect-unresolved-'));
    writeSyntheticExperiment(root);
    const trialId = 'orphan-trial';
    const attemptId = computeAttemptId({ trialId, attemptIndex: 0 });
    const attemptDir = join(root, 'attempts', trialId, attemptId);
    mkdirSync(attemptDir, { recursive: true });
    writeJson(join(attemptDir, 'state.json'), {
      schemaVersion: 1,
      trialId,
      attemptId,
      status: 'completed',
    });

    const collected = await collectExperimentResults(root);
    expect(collected.unresolvedAttempts).toEqual([
      expect.objectContaining({
        trialId,
        attemptId,
        reason: expect.stringContaining('planEntry'),
      }),
    ]);
  });
});
