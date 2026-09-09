import { access, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import {
  CandidateSnapshotSchema,
  GradeReportSchema,
  IsolationCapabilitiesSchema,
  PreregistrationSchema,
  TrialPlanSchema,
  TrialStatusSchema,
  TrialTelemetrySchema,
  computeAttemptId,
  type BlindedAgreementEvidence,
  type CandidateSnapshot,
  type GradeReport,
  type GradeStatus,
  type IsolationCapabilities,
  type MetricValue,
  type Preregistration,
  type TelemetryCoverageSummary,
  type TrialMetricInput,
  type TrialPlan,
  type TrialPlanEntry,
  type TrialStatus,
  type TrialTelemetry,
} from '@ael/core';
import { z } from 'zod';

import { readAtomicJson } from './atomicWrite.js';
import { ARTIFACT_ERROR_CODES, ArtifactError } from './errors.js';
import { resolveArtifactPath } from './paths.js';
import { AttemptStateSchema, type AttemptState } from './schemas.js';

/**
 * Trial runner persists {@link PublicCandidateSnapshot} extras (overlay paths, protected blob
 * refs, scope). The public {@link CandidateSnapshotSchema} is `.strict()`, so collection must
 * accept unknown keys rather than fail-closed on a valid run.
 */
const PersistedCandidateSnapshotSchema = CandidateSnapshotSchema.passthrough();

const MAX_ATTEMPT_INDEX = 64;

const TELEMETRY_METRIC_KEYS = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'reasoningTokens',
  'subagentTokens',
  'toolCalls',
  'estimatedCostUsd',
] as const;

export const BlindedAgreementFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    method: z.enum(['cohen-kappa', 'fleiss-kappa', 'percent-agreement']),
    kappa: z.number().finite().nullable(),
    raterCount: z.number().int().nonnegative(),
    packetCount: z.number().int().nonnegative(),
    ratedPacketCount: z.number().int().nonnegative(),
    minimumKappa: z.number().finite(),
    adequate: z.boolean(),
    adjudicationComplete: z.boolean(),
  })
  .strict();

export type BlindedAgreementFile = z.infer<typeof BlindedAgreementFileSchema>;

export const DoctorArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    observedCapabilities: IsolationCapabilitiesSchema,
    requestedCapabilities: IsolationCapabilitiesSchema.partial().optional(),
    unmetRequiredCapabilities: z.array(z.string().min(1)).optional(),
    supported: z.boolean().optional(),
    messages: z.array(z.string()).optional(),
  })
  .passthrough();

export type DoctorArtifact = z.infer<typeof DoctorArtifactSchema>;

export interface CollectedDoctorEvidence {
  readonly evidencePath: string;
  readonly observedCapabilities: IsolationCapabilities;
  readonly unmetRequiredCapabilities: readonly string[];
  readonly supported: boolean | null;
  readonly messages: readonly string[];
}

export interface CollectedTrialEvidencePaths {
  readonly state: string;
  readonly grade: string | null;
  readonly telemetry: string | null;
  readonly snapshot: string | null;
}

export interface UnresolvedAttempt {
  readonly trialId: string;
  readonly attemptId: string;
  readonly relativeStatePath: string;
  readonly reason: string;
}

export interface CollectedTrialResult {
  readonly trialId: string;
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly fixtureId: string;
  readonly armId: string;
  readonly repeatIndex: number;
  readonly blockIndex: number | null;
  readonly trialIndex: number | null;
  readonly status: TrialStatus;
  readonly gradeStatus: GradeStatus;
  readonly verifiedSuccess: boolean;
  readonly infrastructureFailed: boolean;
  readonly durationMs: number | null;
  readonly telemetry: TrialTelemetry | null;
  readonly costUsd: number | null;
  readonly safetyViolation: boolean;
  readonly safetyIncidents: number;
  readonly secretLeakage: boolean;
  readonly scopeViolation: boolean;
  readonly grade: GradeReport | null;
  readonly snapshot: CandidateSnapshot | null;
  readonly evidencePaths: CollectedTrialEvidencePaths;
}

export interface ExperimentResultSet {
  readonly experimentRoot: string;
  readonly trialPlan: TrialPlan;
  readonly preregistration: Preregistration | null;
  readonly trials: readonly CollectedTrialResult[];
  readonly unresolvedAttempts: readonly UnresolvedAttempt[];
  readonly missingPlanEntries: readonly TrialPlanEntry[];
  readonly blindedAgreement: BlindedAgreementEvidence | null;
  readonly doctor: CollectedDoctorEvidence | null;
  readonly telemetryCoverage: TelemetryCoverageSummary;
}

interface IndexedAttempt {
  readonly state: AttemptState;
  readonly attemptIndex: number;
  readonly relativeStatePath: string;
}

function posixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join('/');
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalJson<T>(targetPath: string, schema: z.ZodType<T>): Promise<T | null> {
  if (!(await pathExists(targetPath))) {
    return null;
  }
  return readAtomicJson(targetPath, schema);
}

function resolveAttemptIndex(trialId: string, attemptId: string): number {
  for (let index = 0; index < MAX_ATTEMPT_INDEX; index += 1) {
    if (computeAttemptId({ trialId, attemptIndex: index }) === attemptId) {
      return index;
    }
  }
  return 0;
}

function durationFromState(state: AttemptState): number | null {
  if (state.durationMs !== undefined && state.durationMs !== null) {
    return Number.isFinite(state.durationMs) ? state.durationMs : null;
  }
  if (state.startedAt === undefined || state.endedAt === undefined) {
    return null;
  }
  const started = Date.parse(state.startedAt);
  const ended = Date.parse(state.endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) {
    return null;
  }
  return ended - started;
}

function safetyFromGrade(grade: GradeReport | null): {
  readonly safetyViolation: boolean;
  readonly safetyIncidents: number;
  readonly secretLeakage: boolean;
  readonly scopeViolation: boolean;
} {
  if (grade === null) {
    return {
      safetyViolation: false,
      safetyIncidents: 0,
      secretLeakage: false,
      scopeViolation: false,
    };
  }
  return {
    safetyViolation: grade.safetyIncidents > 0 || grade.secretLeakage,
    safetyIncidents: grade.safetyIncidents,
    secretLeakage: grade.secretLeakage,
    scopeViolation: grade.scopeViolation,
  };
}

function pairKey(fixtureId: string, armId: string, repeatIndex: number): string {
  return `${fixtureId}\u0000${armId}\u0000${String(repeatIndex)}`;
}

function pickLatestAttempt(attempts: readonly IndexedAttempt[]): IndexedAttempt {
  const ranked = [...attempts].sort((left, right) => {
    if (left.attemptIndex !== right.attemptIndex) {
      return left.attemptIndex - right.attemptIndex;
    }
    return left.state.attemptId.localeCompare(right.state.attemptId);
  });
  const latest = ranked[ranked.length - 1];
  if (latest === undefined) {
    throw new ArtifactError(ARTIFACT_ERROR_CODES.INVALID_JSON, 'Attempt group was empty');
  }
  return latest;
}

async function listAttemptStatePaths(experimentRoot: string): Promise<string[]> {
  const attemptsRoot = resolveArtifactPath(experimentRoot, 'attempts');
  if (!(await pathExists(attemptsRoot))) {
    return [];
  }

  const trialEntries = await readdir(attemptsRoot, { withFileTypes: true });
  const statePaths: string[] = [];

  for (const trialEntry of trialEntries) {
    if (!trialEntry.isDirectory() || trialEntry.name.startsWith('.')) {
      continue;
    }
    const trialDir = join(attemptsRoot, trialEntry.name);
    const attemptEntries = await readdir(trialDir, { withFileTypes: true });
    for (const attemptEntry of attemptEntries) {
      if (!attemptEntry.isDirectory() || attemptEntry.name.startsWith('.')) {
        continue;
      }
      const statePath = join(trialDir, attemptEntry.name, 'state.json');
      if (await pathExists(statePath)) {
        statePaths.push(statePath);
      }
    }
  }

  return statePaths.sort((left, right) => left.localeCompare(right));
}

function accumulateCoverage(
  coverage: { exact: number; estimated: number; unavailable: number; total: number },
  metric: MetricValue<number> | null,
): void {
  coverage.total += 1;
  if (metric === null || metric.quality === 'unavailable' || metric.value === null) {
    coverage.unavailable += 1;
    return;
  }
  if (metric.quality === 'estimated') {
    coverage.estimated += 1;
    return;
  }
  coverage.exact += 1;
}

function telemetryCoverageForTrials(
  trials: readonly CollectedTrialResult[],
): TelemetryCoverageSummary {
  const coverage = { exact: 0, estimated: 0, unavailable: 0, total: 0 };
  for (const trial of trials) {
    if (trial.telemetry === null) {
      for (let index = 0; index < TELEMETRY_METRIC_KEYS.length; index += 1) {
        accumulateCoverage(coverage, null);
      }
      continue;
    }
    for (const key of TELEMETRY_METRIC_KEYS) {
      accumulateCoverage(coverage, trial.telemetry[key]);
    }
  }
  return coverage;
}

export function collectedTrialToMetric(trial: CollectedTrialResult): TrialMetricInput {
  return {
    fixtureId: trial.fixtureId,
    armId: trial.armId,
    repeatIndex: trial.repeatIndex,
    status: trial.status,
    gradeStatus: trial.gradeStatus,
    verifiedSuccess: trial.verifiedSuccess,
    infrastructureFailed: trial.infrastructureFailed,
    durationMs: trial.durationMs,
    safetyViolation: trial.safetyViolation,
  };
}

/**
 * Load the latest attempt per trial from attempts/trialId/attemptId/state.json, join with
 * the sealed trial plan via planEntry, and attach optional grade, telemetry, snapshot,
 * agreement, and doctor artifacts.
 */
export async function collectExperimentResults(
  experimentRoot: string,
): Promise<ExperimentResultSet> {
  const resolvedRoot = resolveArtifactPath(experimentRoot, '.');
  const planPath = resolveArtifactPath(resolvedRoot, 'trial-plan.json');
  if (!(await pathExists(planPath))) {
    throw new ArtifactError(
      ARTIFACT_ERROR_CODES.INVALID_JSON,
      `Missing trial-plan.json under ${experimentRoot}`,
    );
  }
  const trialPlan = await readAtomicJson(planPath, TrialPlanSchema);
  const preregistration = await readOptionalJson(
    resolveArtifactPath(resolvedRoot, 'preregistration.json'),
    PreregistrationSchema,
  );

  const statePaths = await listAttemptStatePaths(resolvedRoot);
  const byTrial = new Map<string, IndexedAttempt[]>();

  for (const statePath of statePaths) {
    const state = await readAtomicJson(statePath, AttemptStateSchema);
    const indexed: IndexedAttempt = {
      state,
      attemptIndex: resolveAttemptIndex(state.trialId, state.attemptId),
      relativeStatePath: posixRelative(resolvedRoot, statePath),
    };
    const existing = byTrial.get(state.trialId) ?? [];
    existing.push(indexed);
    byTrial.set(state.trialId, existing);
  }

  const unresolvedAttempts: UnresolvedAttempt[] = [];
  const trials: CollectedTrialResult[] = [];

  const sortedTrialIds = [...byTrial.keys()].sort((left, right) => left.localeCompare(right));
  for (const trialId of sortedTrialIds) {
    const attempts = byTrial.get(trialId);
    if (attempts === undefined || attempts.length === 0) {
      continue;
    }
    const latest = pickLatestAttempt(attempts);
    const planEntry = latest.state.planEntry;
    if (planEntry === undefined) {
      unresolvedAttempts.push({
        trialId,
        attemptId: latest.state.attemptId,
        relativeStatePath: latest.relativeStatePath,
        reason: 'state.json is missing planEntry; cannot join the trial plan',
      });
      continue;
    }

    const statusParsed = TrialStatusSchema.safeParse(latest.state.status);
    if (!statusParsed.success) {
      unresolvedAttempts.push({
        trialId,
        attemptId: latest.state.attemptId,
        relativeStatePath: latest.relativeStatePath,
        reason: 'state.json has an unknown trial status',
      });
      continue;
    }

    const attemptDir = resolveArtifactPath(
      resolvedRoot,
      join('attempts', trialId, latest.state.attemptId),
    );
    const gradePath = join(attemptDir, 'grade.json');
    const telemetryPath = join(attemptDir, 'telemetry.json');
    const snapshotPath = join(attemptDir, 'candidate-snapshot.json');

    const grade = await readOptionalJson(gradePath, GradeReportSchema);
    const telemetry = await readOptionalJson(telemetryPath, TrialTelemetrySchema);
    const snapshot = await readOptionalJson(snapshotPath, PersistedCandidateSnapshotSchema);
    const safety = safetyFromGrade(grade);
    const gradeStatus: GradeStatus = grade?.status ?? 'not_graded';
    const planned = trialPlan.trials.find(
      (entry) =>
        entry.fixtureId === planEntry.fixtureId &&
        entry.armId === planEntry.armId &&
        entry.repeatIndex === planEntry.repeatIndex,
    );

    trials.push({
      trialId,
      attemptId: latest.state.attemptId,
      attemptIndex: latest.attemptIndex,
      fixtureId: planEntry.fixtureId,
      armId: planEntry.armId,
      repeatIndex: planEntry.repeatIndex,
      blockIndex: planned?.blockIndex ?? planEntry.blockIndex,
      trialIndex: planned?.trialIndex ?? planEntry.trialIndex,
      status: statusParsed.data,
      gradeStatus,
      verifiedSuccess: gradeStatus === 'verified_success',
      infrastructureFailed: statusParsed.data === 'infrastructure_failed',
      durationMs: durationFromState(latest.state),
      telemetry,
      costUsd: telemetry?.estimatedCostUsd.value ?? null,
      safetyViolation: safety.safetyViolation,
      safetyIncidents: safety.safetyIncidents,
      secretLeakage: safety.secretLeakage,
      scopeViolation: safety.scopeViolation,
      grade,
      snapshot,
      evidencePaths: {
        state: latest.relativeStatePath,
        grade: grade === null ? null : posixRelative(resolvedRoot, gradePath),
        telemetry: telemetry === null ? null : posixRelative(resolvedRoot, telemetryPath),
        snapshot: snapshot === null ? null : posixRelative(resolvedRoot, snapshotPath),
      },
    });
  }

  trials.sort((left, right) => {
    if (left.fixtureId !== right.fixtureId) {
      return left.fixtureId.localeCompare(right.fixtureId);
    }
    if (left.armId !== right.armId) {
      return left.armId.localeCompare(right.armId);
    }
    return left.repeatIndex - right.repeatIndex;
  });

  const collectedKeys = new Set(
    trials.map((trial) => pairKey(trial.fixtureId, trial.armId, trial.repeatIndex)),
  );
  const missingPlanEntries = trialPlan.trials.filter(
    (entry) => !collectedKeys.has(pairKey(entry.fixtureId, entry.armId, entry.repeatIndex)),
  );

  const agreementPath = resolveArtifactPath(resolvedRoot, 'blinded/agreement.json');
  const agreementFile = await readOptionalJson(agreementPath, BlindedAgreementFileSchema);
  const blindedAgreement: BlindedAgreementEvidence | null =
    agreementFile === null
      ? null
      : {
          evidencePath: 'blinded/agreement.json',
          method: agreementFile.method,
          kappa: agreementFile.kappa,
          minimumKappa: agreementFile.minimumKappa,
          adequate: agreementFile.adequate,
          adjudicationComplete: agreementFile.adjudicationComplete,
          raterCount: agreementFile.raterCount,
          packetCount: agreementFile.packetCount,
          ratedPacketCount: agreementFile.ratedPacketCount,
        };

  const doctorPath = resolveArtifactPath(resolvedRoot, 'doctor.json');
  const doctorFile = await readOptionalJson(doctorPath, DoctorArtifactSchema);
  const doctor: CollectedDoctorEvidence | null =
    doctorFile === null
      ? null
      : {
          evidencePath: 'doctor.json',
          observedCapabilities: doctorFile.observedCapabilities,
          unmetRequiredCapabilities: [...(doctorFile.unmetRequiredCapabilities ?? [])].sort(),
          supported: doctorFile.supported ?? null,
          messages: doctorFile.messages ?? [],
        };

  return {
    experimentRoot: resolvedRoot,
    trialPlan,
    preregistration,
    trials,
    unresolvedAttempts,
    missingPlanEntries,
    blindedAgreement,
    doctor,
    telemetryCoverage: telemetryCoverageForTrials(trials),
  };
}
