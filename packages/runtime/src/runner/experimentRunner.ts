import { join } from 'node:path';

import type {
  AgentAdapter,
  ArmDocument,
  FixtureDocument,
  GradeStatus,
  IsolationProvider,
  Preregistration,
  PricingSnapshot,
  SuiteDocument,
  TrialPlan,
  TrialPlanEntry,
  TrialStatus,
} from '@ael/core';
import {
  GradeReportSchema,
  TrialStatusSchema,
  computeAttemptId,
  computeTrialId,
  fingerprintRecord,
} from '@ael/core';

import { AttemptStore } from '../artifacts/attempts.js';
import { readAtomicJson, writeAtomicJson } from '../artifacts/atomicWrite.js';
import { ExperimentLock } from '../artifacts/experimentLock.js';
import type { AttemptState } from '../artifacts/schemas.js';
import {
  pricingFingerprintForSuite,
  resolveSuitePricingPath,
  loadPricingSnapshot,
} from '../telemetry/pricing.js';
import {
  ConcurrencyLimiter,
  createCancellationToken,
  installSigintHandler,
  type SigintEmitter,
} from './concurrency.js';
import {
  buildResumeFingerprints,
  evaluateResume,
  isInfrastructureIncidentStatus,
  RUNNER_VERSION,
  type ResumeAction,
  type ResumeFingerprints,
  type StoredResumeFingerprints,
} from './resume.js';
import { runTrial } from './trialRunner.js';

export const RUN_SUMMARY_FILENAME = 'run-summary.json';

/** Extra attempt indices probed when mapping legacy attempt directories back to their index. */
const ATTEMPT_INDEX_SCAN_SLACK = 16;

export interface ExperimentRunnerInput {
  readonly experimentRoot: string;
  readonly suite: SuiteDocument;
  readonly suiteRoot: string;
  readonly suiteFingerprint: string;
  /** Defaults to `suiteFingerprint` (the current experiment identity is derived from the suite). */
  readonly experimentFingerprint?: string;
  readonly trialPlan: TrialPlan;
  readonly preregistration: Preregistration;
  readonly fixtures: ReadonlyMap<string, { document: FixtureDocument; root: string }>;
  readonly arms: ReadonlyMap<string, { document: ArmDocument; path: string }>;
  readonly adapter: AgentAdapter;
  readonly isolation: IsolationProvider;
  readonly sourceRepositoryPath: string;
  readonly agentFingerprint: string;
  readonly isolationFingerprint: string;
  readonly pricingFingerprint: string;
  readonly maxInfraRetries?: number;
  readonly concurrency?: number;
  /** Injectable trial runner (tests); defaults to `runTrial`. */
  readonly trialRunner?: typeof runTrial;
  /** Invoked once on the first interrupt (Ctrl+C). */
  readonly onInterrupt?: () => void;
  /**
   * Test seam for the second Ctrl+C. Defaults to `process.exit`. Real runs should omit this so
   * the second interrupt exits with code 130 after releasing the experiment lock.
   */
  readonly forceExit?: (code: number) => void;
  /** Test seam; defaults to `process`. */
  readonly sigintEmitter?: SigintEmitter;
}

export type TrialResumeAction = ResumeAction | 'fresh';

export interface ExperimentTrialResult {
  readonly trialId: string;
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly status: TrialStatus;
  readonly gradeStatus: GradeStatus;
  /** How the runner arrived at this result: fresh run, resume decision, or skip. */
  readonly resumeAction: TrialResumeAction;
  readonly reason: string | null;
}

export interface ExperimentCancellation {
  readonly cancelled: boolean;
  /** Planned trials that were never scheduled because cancellation happened first. */
  readonly unscheduledTrials: number;
}

export interface ExperimentRunnerResult {
  readonly completedTrials: number;
  /** One entry per planned trial that could be resolved, in trial-plan order. */
  readonly results: ExperimentTrialResult[];
  /** True when at least one trial was blocked by CONFIG_DRIFT / UNKNOWN_PROVENANCE. */
  readonly configDrift: boolean;
  readonly driftedTrials: string[];
  /** Trials whose infrastructure retry budget was exhausted (INFRA_RETRY_EXHAUSTED). */
  readonly exhaustedTrials: string[];
  readonly cancelled: boolean;
  readonly cancellation: ExperimentCancellation;
  readonly runnerVersion: string;
  readonly summaryPath: string;
}

export interface RunSummary {
  readonly schemaVersion: 1;
  readonly runnerVersion: string;
  readonly writtenAt: string;
  readonly cancelled: boolean;
  readonly unscheduledTrials: number;
  readonly plannedTrials: number;
  readonly reportedTrials: number;
  readonly completedTrials: number;
  readonly statusCounts: Record<string, number>;
  readonly gradeStatusCounts: Record<string, number>;
  readonly resumeActionCounts: Record<string, number>;
  readonly driftedTrials: string[];
  readonly exhaustedTrials: string[];
}

interface LoadedAttempt {
  readonly attemptId: string;
  readonly attemptIndex: number;
  /** Stored status, or `'unknown'` when `state.json` is missing or invalid. */
  readonly status: string;
  readonly stored: StoredResumeFingerprints;
}

export function fixtureRequiresResumeCapability(fixtures: Iterable<FixtureDocument>): boolean {
  for (const fixture of fixtures) {
    for (const phase of fixture.phases) {
      if (phase.session === 'resume') {
        return true;
      }
    }
  }
  return false;
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const bucket = key(item);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts;
}

function fingerprintsFromState(state: AttemptState | null): StoredResumeFingerprints {
  if (state === null) {
    return {};
  }
  const pick = (
    key: keyof ResumeFingerprints,
    value: string | undefined,
  ): Partial<ResumeFingerprints> => (value !== undefined ? { [key]: value } : {});
  return {
    ...pick('experimentFingerprint', state.experimentFingerprint),
    ...pick('suiteFingerprint', state.suiteFingerprint),
    ...pick('agentFingerprint', state.agentFingerprint),
    ...pick('isolationFingerprint', state.isolationFingerprint),
    ...pick('pricingFingerprint', state.pricingFingerprint),
    ...pick('runnerVersion', state.runnerVersion),
  };
}

async function loadTrialAttempts(store: AttemptStore, trialId: string): Promise<LoadedAttempt[]> {
  const attemptIds = await store.listAttemptIds(trialId);
  if (attemptIds.length === 0) {
    return [];
  }

  const indexByAttemptId = new Map<string, number>();
  for (let index = 0; index < attemptIds.length + ATTEMPT_INDEX_SCAN_SLACK; index += 1) {
    indexByAttemptId.set(computeAttemptId({ trialId, attemptIndex: index }), index);
  }

  const attempts: LoadedAttempt[] = [];
  for (const attemptId of attemptIds) {
    const state = await store.readAttemptState(trialId, attemptId).catch(() => null);
    const provenance = await store.readAttemptProvenance(trialId, attemptId).catch(() => null);
    const attemptIndex =
      state?.attemptIndex ?? provenance?.attemptIndex ?? indexByAttemptId.get(attemptId);
    if (attemptIndex === undefined) {
      // Not an attempt directory produced for this trial; ignore rather than guess.
      continue;
    }
    attempts.push({
      attemptId,
      attemptIndex,
      status: state?.status ?? 'unknown',
      stored: provenance !== null ? provenance : fingerprintsFromState(state),
    });
  }

  attempts.sort((left, right) => left.attemptIndex - right.attemptIndex);
  return attempts;
}

function toTrialStatus(status: string): TrialStatus | null {
  const parsed = TrialStatusSchema.safeParse(status);
  return parsed.success ? parsed.data : null;
}

async function readStoredGradeStatus(attemptDir: string): Promise<GradeStatus> {
  try {
    const report = await readAtomicJson(join(attemptDir, 'grade.json'), GradeReportSchema);
    return report.status;
  } catch {
    return 'not_graded';
  }
}

export async function runExperiment(input: ExperimentRunnerInput): Promise<ExperimentRunnerResult> {
  const lock = new ExperimentLock(join(input.experimentRoot, 'lock.json'));
  await lock.acquire();

  const cancellation = createCancellationToken();
  const removeSigint = installSigintHandler(
    cancellation,
    () => {
      input.onInterrupt?.();
    },
    {
      onSecondInterrupt: () => lock.release().catch(() => undefined),
      ...(input.forceExit !== undefined ? { forceExit: input.forceExit } : {}),
      ...(input.sigintEmitter !== undefined ? { emitter: input.sigintEmitter } : {}),
    },
  );

  const summaryPath = join(input.experimentRoot, RUN_SUMMARY_FILENAME);
  const trialRunner = input.trialRunner ?? runTrial;
  const store = new AttemptStore(input.experimentRoot);
  const maxInfraRetries = input.maxInfraRetries ?? 2;
  const concurrency = Math.max(
    1,
    Math.floor(input.concurrency ?? input.suite.defaults.concurrency),
  );
  const limiter = new ConcurrencyLimiter(concurrency);
  const experimentFingerprint = input.experimentFingerprint ?? input.suiteFingerprint;

  const currentFingerprints = buildResumeFingerprints({
    experimentFingerprint,
    suiteFingerprint: input.suiteFingerprint,
    agentFingerprint: input.agentFingerprint,
    isolationFingerprint: input.isolationFingerprint,
    pricingFingerprint: input.pricingFingerprint,
  });

  const planned = input.trialPlan.trials;
  const slots: Array<ExperimentTrialResult | null> = planned.map(() => null);
  let unscheduledTrials = 0;

  const runPlannedTrial = async (
    entry: TrialPlanEntry,
    pricingSnapshot: PricingSnapshot | null,
  ): Promise<ExperimentTrialResult | null> => {
    const fixture = input.fixtures.get(entry.fixtureId);
    const arm = input.arms.get(entry.armId);
    if (fixture === undefined || arm === undefined) {
      return null;
    }

    const trialId = computeTrialId({
      experimentFingerprint,
      suiteFingerprint: input.suiteFingerprint,
      fixtureFingerprint: fingerprintRecord('fixture', 1, fixture.document),
      armFingerprint: fingerprintRecord('arm', 1, arm.document),
      agentFingerprint: input.agentFingerprint,
      isolationFingerprint: input.isolationFingerprint,
      pricingFingerprint: input.pricingFingerprint,
      repeatIndex: entry.repeatIndex,
    });

    let attemptIndex = 0;
    let resumeAction: TrialResumeAction = 'fresh';
    let reason: string | null = null;
    let resumeFromStatus: TrialStatus | undefined;

    const attempts = await loadTrialAttempts(store, trialId);
    const latest = attempts.at(-1);
    if (latest !== undefined) {
      const infraFailureCount = attempts.filter((attempt) =>
        isInfrastructureIncidentStatus(attempt.status),
      ).length;
      const decision = evaluateResume({
        stored: latest.stored,
        current: currentFingerprints,
        attemptStatus: latest.status,
        attemptIndex: latest.attemptIndex,
        maxInfraRetries,
        infraFailureCount,
      });
      resumeAction = decision.action;
      reason = decision.reason;
      const latestDir = join(input.experimentRoot, 'attempts', trialId, latest.attemptId);

      switch (decision.action) {
        case 'config_drift': {
          return {
            trialId,
            attemptId: latest.attemptId,
            attemptIndex: latest.attemptIndex,
            status: 'infrastructure_failed',
            gradeStatus: 'invalid_trial',
            resumeAction,
            reason,
          };
        }
        case 'infra_retry_exhausted': {
          return {
            trialId,
            attemptId: latest.attemptId,
            attemptIndex: latest.attemptIndex,
            status: 'infrastructure_failed',
            gradeStatus: 'invalid_trial',
            resumeAction,
            reason,
          };
        }
        case 'skip': {
          const storedStatus = toTrialStatus(latest.status) ?? 'infrastructure_failed';
          return {
            trialId,
            attemptId: latest.attemptId,
            attemptIndex: latest.attemptIndex,
            status: storedStatus,
            gradeStatus: await readStoredGradeStatus(latestDir),
            resumeAction,
            reason,
          };
        }
        case 'resume': {
          attemptIndex = decision.attemptIndex;
          resumeFromStatus = toTrialStatus(latest.status) ?? undefined;
          break;
        }
        case 'new_attempt': {
          attemptIndex = decision.attemptIndex;
          break;
        }
      }
    }

    const attemptId = computeAttemptId({ trialId, attemptIndex });
    const attemptDir = join(input.experimentRoot, 'attempts', trialId, attemptId);

    // Runner-owned provenance is written before any side effect so a crash mid-trial still leaves
    // enough information to detect drift on resume.
    await store.writeAttemptProvenance({
      schemaVersion: 1,
      trialId,
      attemptId,
      attemptIndex,
      ...currentFingerprints,
      startedAt: new Date().toISOString(),
    });

    const trialResult = await trialRunner({
      experimentRoot: input.experimentRoot,
      trialId,
      attemptId,
      suite: input.suite,
      suiteRoot: input.suiteRoot,
      fixture: fixture.document,
      fixtureRoot: fixture.root,
      arm: arm.document,
      planEntry: entry,
      adapter: input.adapter,
      isolation: input.isolation,
      sourceRepositoryPath: input.sourceRepositoryPath,
      pricingSnapshot,
      cancellationToken: cancellation,
      ...(resumeFromStatus !== undefined ? { resumeFromStatus } : {}),
    });

    // Merge provenance into the trial runner's final checkpoint without dropping its fields.
    const checkpoint = await store.readAttemptState(trialId, attemptId).catch(() => null);
    await writeAtomicJson(join(attemptDir, 'state.json'), {
      ...(checkpoint ?? {}),
      schemaVersion: 1,
      trialId,
      attemptId,
      attemptIndex,
      status: trialResult.status,
      ...currentFingerprints,
    }).catch(() => undefined);

    return {
      trialId,
      attemptId,
      attemptIndex,
      status: trialResult.status,
      gradeStatus: trialResult.gradeStatus,
      resumeAction,
      reason,
    };
  };

  try {
    const pricingPath = resolveSuitePricingPath(input.suiteRoot);
    const pricingSnapshot =
      pricingPath !== null ? loadPricingSnapshot(input.suiteRoot, pricingPath) : null;

    const inFlight: Array<Promise<void>> = [];
    // Unexpected exceptions from a trial stop scheduling (fail closed) and are rethrown after
    // in-flight trials have settled.
    const fatalErrors: unknown[] = [];
    const shouldStopScheduling = () => cancellation.cancelled || fatalErrors.length > 0;

    for (const [index, entry] of planned.entries()) {
      if (shouldStopScheduling()) {
        unscheduledTrials += 1;
        continue;
      }
      const release = await limiter.acquire();
      if (shouldStopScheduling()) {
        release();
        unscheduledTrials += 1;
        continue;
      }
      inFlight.push(
        runPlannedTrial(entry, pricingSnapshot)
          .then(
            (result) => {
              slots[index] = result;
            },
            (error: unknown) => {
              fatalErrors.push(error);
            },
          )
          .finally(release),
      );
    }

    // In-flight trials are always awaited, whether we stopped for cancellation or a fatal error.
    await Promise.all(inFlight);
    const [firstFatal] = fatalErrors;
    if (fatalErrors.length > 0) {
      throw firstFatal instanceof Error
        ? firstFatal
        : new Error('trial runner failed', { cause: firstFatal });
    }

    const results = slots.filter((slot): slot is ExperimentTrialResult => slot !== null);
    const completedTrials = results.filter((result) => result.status === 'completed').length;
    const driftedTrials = results
      .filter((result) => result.resumeAction === 'config_drift')
      .map((result) => result.trialId);
    const exhaustedTrials = results
      .filter((result) => result.resumeAction === 'infra_retry_exhausted')
      .map((result) => result.trialId);

    const summary: RunSummary = {
      schemaVersion: 1,
      runnerVersion: RUNNER_VERSION,
      writtenAt: new Date().toISOString(),
      cancelled: cancellation.cancelled,
      unscheduledTrials,
      plannedTrials: planned.length,
      reportedTrials: results.length,
      completedTrials,
      statusCounts: countBy(results, (result) => result.status),
      gradeStatusCounts: countBy(results, (result) => result.gradeStatus),
      resumeActionCounts: countBy(results, (result) => result.resumeAction),
      driftedTrials,
      exhaustedTrials,
    };
    await writeAtomicJson(summaryPath, summary);

    return {
      completedTrials,
      results,
      configDrift: driftedTrials.length > 0,
      driftedTrials,
      exhaustedTrials,
      cancelled: cancellation.cancelled,
      cancellation: { cancelled: cancellation.cancelled, unscheduledTrials },
      runnerVersion: RUNNER_VERSION,
      summaryPath,
    };
  } finally {
    removeSigint();
    await lock.release();
  }
}

export { pricingFingerprintForSuite };
