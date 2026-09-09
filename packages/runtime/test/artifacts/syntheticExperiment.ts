import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildTrialPlan,
  computeAttemptId,
  type GradeReport,
  type GradeStatus,
  type TrialPlan,
  type TrialPlanEntry,
  type TrialStatus,
  type TrialTelemetry,
} from '@ael/core';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function grade(status: GradeStatus, safetyIncidents = 0): GradeReport {
  return {
    schemaVersion: 1,
    status,
    verified: status === 'verified_success',
    acceptancePassed: status === 'verified_success' ? 1 : 0,
    acceptanceTotal: 1,
    criticalFindings: 0,
    importantFindings: 0,
    safetyIncidents,
    scopeViolation: false,
    testTampering: false,
    secretLeakage: false,
    staleEvidenceAccepted: null,
    recoveryRequired: false,
    recoveryPassed: null,
    safeActions: 0,
    falseBlocks: 0,
    checks: [],
  };
}

function telemetry(durationHint: number): TrialTelemetry {
  return {
    schemaVersion: 1,
    inputTokens: {
      value: durationHint,
      quality: 'exact',
      source: 'synthetic',
      coverageReason: null,
    },
    outputTokens: { value: 2, quality: 'exact', source: 'synthetic', coverageReason: null },
    cachedInputTokens: { value: 0, quality: 'exact', source: 'synthetic', coverageReason: null },
    reasoningTokens: {
      value: null,
      quality: 'unavailable',
      source: null,
      coverageReason: 'synthetic',
    },
    subagentTokens: {
      value: null,
      quality: 'unavailable',
      source: null,
      coverageReason: 'synthetic',
    },
    toolCalls: { value: 1, quality: 'estimated', source: 'synthetic', coverageReason: null },
    estimatedCostUsd: {
      value: 0.01,
      quality: 'estimated',
      source: 'pricing',
      coverageReason: null,
    },
    phaseCount: 1,
    rawArtifactPath: null,
  };
}

function trialIdFor(entry: TrialPlanEntry): string {
  return `trial-${entry.fixtureId}-${entry.armId}-${String(entry.repeatIndex)}`;
}

interface Outcome {
  readonly status: TrialStatus;
  readonly gradeStatus: GradeStatus;
  readonly durationMs: number | null;
  readonly extraAttempts?: number;
}

function outcomes(): Map<string, Outcome> {
  return new Map([
    [
      'bug-fix:baseline:0',
      { status: 'completed', gradeStatus: 'incorrect', durationMs: 100, extraAttempts: 1 },
    ],
    [
      'bug-fix:treatment:0',
      { status: 'completed', gradeStatus: 'verified_success', durationMs: 110 },
    ],
    [
      'bug-fix:baseline:1',
      { status: 'completed', gradeStatus: 'verified_success', durationMs: 120 },
    ],
    [
      'bug-fix:treatment:1',
      { status: 'completed', gradeStatus: 'verified_success', durationMs: 130 },
    ],
    [
      'regression:baseline:0',
      { status: 'infrastructure_failed', gradeStatus: 'not_graded', durationMs: null },
    ],
    [
      'regression:treatment:0',
      { status: 'completed', gradeStatus: 'verified_success', durationMs: 150 },
    ],
    ['regression:baseline:1', { status: 'completed', gradeStatus: 'incorrect', durationMs: 160 }],
    ['regression:treatment:1', { status: 'completed', gradeStatus: 'incorrect', durationMs: 170 }],
    ['claims-done:baseline:0', { status: 'completed', gradeStatus: 'incorrect', durationMs: 180 }],
    [
      'claims-done:treatment:0',
      { status: 'completed', gradeStatus: 'verified_success', durationMs: 190 },
    ],
    [
      'claims-done:baseline:1',
      { status: 'completed', gradeStatus: 'verified_success', durationMs: 200 },
    ],
  ]);
}

/** 3 fixtures × 2 arms × 2 repeats; one infra failure; one missing treatment trial. */
export function writeSyntheticExperiment(root: string): TrialPlan {
  const plan = buildTrialPlan({
    fixtureIds: ['bug-fix', 'claims-done', 'regression'],
    armIds: ['baseline', 'treatment'],
    repeats: 2,
    randomSeed: 'synth-seed',
    primaryControlArm: 'baseline',
    primaryTreatmentArm: 'treatment',
    timeoutMs: 1000,
    phasesPerFixture: 1,
  });
  writeJson(join(root, 'trial-plan.json'), plan);
  writeJson(join(root, 'preregistration.json'), {
    schemaVersion: 1,
    suiteFingerprint: 'suite-fp',
    trialPlanFingerprint: plan.fingerprint,
    sealedAt: '1970-01-01T00:00:00.000Z',
    randomSeed: 'synth-seed',
    primaryControlArm: 'baseline',
    primaryTreatmentArm: 'treatment',
    decisionPolicyMode: 'exploratory',
  });

  const table = outcomes();
  for (const entry of plan.trials) {
    const key = `${entry.fixtureId}:${entry.armId}:${String(entry.repeatIndex)}`;
    const outcome = table.get(key);
    if (outcome === undefined) {
      continue;
    }
    const trialId = trialIdFor(entry);
    const extra = outcome.extraAttempts ?? 0;
    for (let attemptIndex = 0; attemptIndex <= extra; attemptIndex += 1) {
      const attemptId = computeAttemptId({ trialId, attemptIndex });
      const attemptDir = join(root, 'attempts', trialId, attemptId);
      mkdirSync(attemptDir, { recursive: true });
      const isLatest = attemptIndex === extra;
      const status = isLatest ? outcome.status : 'agent_failed';
      writeJson(join(attemptDir, 'state.json'), {
        schemaVersion: 1,
        trialId,
        attemptId,
        status,
        planEntry: entry,
        durationMs: isLatest ? outcome.durationMs : 50,
        runnerVersion: 'test',
      });
      if (isLatest && outcome.status === 'completed') {
        writeJson(join(attemptDir, 'grade.json'), grade(outcome.gradeStatus));
        writeJson(join(attemptDir, 'telemetry.json'), telemetry(outcome.durationMs ?? 0));
      }
    }
  }

  return plan;
}
