import type { GradeStatus, TrialStatus } from '../contracts/trial.js';
import { clusterBootstrapCi, type ClusterBootstrapResult } from './bootstrap.js';
import { applyHolmCorrection, type HolmCorrectionResult } from './holm.js';
import {
  POWER_READINESS_VERSION,
  assessPowerReadiness,
  type PowerReadinessWarning,
} from './power.js';
import {
  computeRate,
  median,
  pairedSignTest,
  percentileNearestRank,
  sortNumeric,
  type PairedFixtureOutcome,
  type PairedSignTestResult,
} from './summary.js';

export const EXPERIMENT_STATISTICS_VERSION = 'experiment-statistics-v2' as const;
export const PAIRED_SIGN_TEST_METHOD = 'paired-exact-sign-test-one-sided' as const;
export const DEFAULT_MINIMUM_DISCORDANT_PAIRS = 5;
export const DEFAULT_MINIMUM_DETECTABLE_DELTA = 0.2;

export type ExperimentVerdict = 'PASSED' | 'FAILED' | 'INSUFFICIENT_DATA';

export type MultipleComparisonMethod = 'holm' | 'bonferroni' | 'none';

/** One trial as consumed by the statistics layer (runtime collectors produce a superset). */
export interface TrialMetricInput {
  readonly fixtureId: string;
  readonly armId: string;
  readonly repeatIndex: number;
  /** Runtime status; only `completed` trials contribute to pairs. Defaults to `completed` when omitted. */
  readonly status?: TrialStatus;
  readonly gradeStatus?: GradeStatus;
  readonly verifiedSuccess: boolean;
  readonly infrastructureFailed: boolean;
  readonly durationMs: number | null;
  /** Any safety violation recorded by the independent grader (defaults to false). */
  readonly safetyViolation?: boolean;
}

export interface ComputeStatisticsInput {
  readonly controlArm: string;
  readonly treatmentArm: string;
  /** Additional treatment arms compared against the control with a multiplicity correction. */
  readonly secondaryTreatmentArms?: readonly string[];
  readonly trials: readonly TrialMetricInput[];
  /** Seed for the cluster bootstrap (use the preregistration random seed). */
  readonly randomSeed?: string;
  readonly bootstrapIterations?: number;
  readonly confidenceLevel?: number;
  readonly multipleComparisonMethod?: MultipleComparisonMethod;
  /** Alpha used for Holm significance flags (typically `pairedImprovementPValueMax`). */
  readonly alpha?: number;
  readonly minimumDiscordantPairs?: number;
  readonly minimumDetectableDelta?: number;
  /** Pairs the trial plan intended to produce; used to count missing pairs. */
  readonly plannedPairs?: number;
}

export type PairOutcome = 'improvement' | 'regression' | 'tie' | 'missing';

export interface FixturePairRecord {
  readonly fixtureId: string;
  readonly repeatIndex: number;
  readonly controlStatus: TrialStatus | null;
  readonly treatmentStatus: TrialStatus | null;
  readonly controlSuccess: boolean | null;
  readonly treatmentSuccess: boolean | null;
  readonly outcome: PairOutcome;
}

export interface ArmSummary {
  readonly armId: string;
  readonly trialCount: number;
  readonly completedCount: number;
  readonly verifiedSuccessCount: number;
  readonly verifiedSuccessRate: number | null;
  readonly infrastructureFailureCount: number;
  readonly safetyViolationCount: number;
  readonly medianDurationMs: number | null;
  readonly p90DurationMs: number | null;
  readonly p95DurationMs: number | null;
}

export interface SecondaryComparison {
  readonly treatmentArm: string;
  readonly completedPairs: number;
  readonly pairedSignTest: PairedSignTestResult;
  readonly verifiedSuccessDelta: number | null;
  readonly rawPValue: number | null;
  /** Holm-adjusted one-sided p-value; null when no correction applied or raw p unavailable. */
  readonly adjustedPValue: number | null;
}

export interface PowerReadiness {
  readonly version: typeof POWER_READINESS_VERSION;
  readonly discordantPairs: number;
  readonly minimumDiscordantPairs: number;
  readonly independentFixtureCount: number;
  readonly minimumDetectableDelta: number;
  /** True when the experiment cannot support a conclusive verdict at the requested effect size. */
  readonly lowPower: boolean;
  readonly reasons: readonly string[];
  readonly fixtureWarning: PowerReadinessWarning | null;
}

export interface ExperimentStatisticsBase {
  readonly independentFixtureCount: number;
  readonly trialCount: number;
  readonly pairedSignTest: PairedSignTestResult;
  readonly verifiedSuccessDelta: number | null;
  readonly controlVerifiedSuccessRate: number | null;
  readonly treatmentVerifiedSuccessRate: number | null;
  readonly controlMedianDurationMs: number | null;
  readonly treatmentMedianDurationMs: number | null;
  readonly controlP90DurationMs: number | null;
  readonly treatmentP90DurationMs: number | null;
  readonly controlP95DurationMs: number | null;
  readonly treatmentP95DurationMs: number | null;
  readonly infrastructureFailureRate: number | null;
}

export interface ExperimentStatistics extends ExperimentStatisticsBase {
  readonly version: typeof EXPERIMENT_STATISTICS_VERSION;
  readonly completedPairs: number;
  readonly missingPairs: number;
  readonly discordantPairs: number;
  readonly treatmentSafetyViolations: number;
  readonly pairs: readonly FixturePairRecord[];
  readonly arms: readonly ArmSummary[];
  /** Cluster bootstrap CI of the mean per-fixture paired success delta (treatment - control). */
  readonly bootstrap: ClusterBootstrapResult;
  readonly secondaryComparisons: readonly SecondaryComparison[];
  readonly holm: HolmCorrectionResult | null;
  readonly powerReadiness: PowerReadiness;
  readonly methods: {
    readonly signTest: typeof PAIRED_SIGN_TEST_METHOD;
    readonly bootstrap: ClusterBootstrapResult['method'];
    readonly multipleComparison: MultipleComparisonMethod;
  };
}

/** Legacy callers (pre-v2 reportCommand) may omit the extended fields. */
export type ExperimentStatisticsLike = ExperimentStatisticsBase &
  Partial<Omit<ExperimentStatistics, keyof ExperimentStatisticsBase>>;

interface PairKey {
  readonly fixtureId: string;
  readonly repeatIndex: number;
}

function trialStatus(trial: TrialMetricInput): TrialStatus {
  return trial.status ?? 'completed';
}

function isCompleted(trial: TrialMetricInput): boolean {
  return trialStatus(trial) === 'completed';
}

function compareKeys(left: PairKey, right: PairKey): number {
  if (left.fixtureId !== right.fixtureId) {
    return left.fixtureId.localeCompare(right.fixtureId);
  }
  return left.repeatIndex - right.repeatIndex;
}

function collectPairKeys(
  trials: readonly TrialMetricInput[],
  controlArm: string,
  treatmentArm: string,
): PairKey[] {
  const keys = new Map<string, PairKey>();
  for (const trial of trials) {
    if (trial.armId !== controlArm && trial.armId !== treatmentArm) {
      continue;
    }
    const key = `${trial.fixtureId}\u0000${String(trial.repeatIndex)}`;
    if (!keys.has(key)) {
      keys.set(key, { fixtureId: trial.fixtureId, repeatIndex: trial.repeatIndex });
    }
  }
  return [...keys.values()].sort(compareKeys);
}

function findTrial(
  trials: readonly TrialMetricInput[],
  key: PairKey,
  armId: string,
): TrialMetricInput | undefined {
  return trials.find(
    (trial) =>
      trial.fixtureId === key.fixtureId &&
      trial.repeatIndex === key.repeatIndex &&
      trial.armId === armId,
  );
}

function buildPairTable(
  trials: readonly TrialMetricInput[],
  controlArm: string,
  treatmentArm: string,
): FixturePairRecord[] {
  return collectPairKeys(trials, controlArm, treatmentArm).map((key) => {
    const control = findTrial(trials, key, controlArm);
    const treatment = findTrial(trials, key, treatmentArm);
    const bothCompleted =
      control !== undefined &&
      treatment !== undefined &&
      isCompleted(control) &&
      isCompleted(treatment);
    let outcome: PairOutcome = 'missing';
    if (bothCompleted) {
      if (treatment.verifiedSuccess && !control.verifiedSuccess) {
        outcome = 'improvement';
      } else if (!treatment.verifiedSuccess && control.verifiedSuccess) {
        outcome = 'regression';
      } else {
        outcome = 'tie';
      }
    }
    return {
      fixtureId: key.fixtureId,
      repeatIndex: key.repeatIndex,
      controlStatus: control === undefined ? null : trialStatus(control),
      treatmentStatus: treatment === undefined ? null : trialStatus(treatment),
      controlSuccess: bothCompleted ? control.verifiedSuccess : null,
      treatmentSuccess: bothCompleted ? treatment.verifiedSuccess : null,
      outcome,
    };
  });
}

function pairedOutcomesFromTable(pairs: readonly FixturePairRecord[]): PairedFixtureOutcome[] {
  const outcomes: PairedFixtureOutcome[] = [];
  for (const pair of pairs) {
    if (pair.controlSuccess === null || pair.treatmentSuccess === null) {
      continue;
    }
    outcomes.push({
      fixtureId: pair.fixtureId,
      controlSuccess: pair.controlSuccess,
      treatmentSuccess: pair.treatmentSuccess,
    });
  }
  return outcomes;
}

function summarizeArm(trials: readonly TrialMetricInput[], armId: string): ArmSummary {
  const armTrials = trials.filter((trial) => trial.armId === armId);
  const completed = armTrials.filter(isCompleted);
  const durations = sortNumeric(
    completed
      .map((trial) => trial.durationMs)
      .filter((value): value is number => value !== null && Number.isFinite(value)),
  );
  const verifiedSuccessCount = completed.filter((trial) => trial.verifiedSuccess).length;
  return {
    armId,
    trialCount: armTrials.length,
    completedCount: completed.length,
    verifiedSuccessCount,
    verifiedSuccessRate: computeRate(verifiedSuccessCount, completed.length),
    infrastructureFailureCount: armTrials.filter((trial) => trial.infrastructureFailed).length,
    safetyViolationCount: armTrials.filter((trial) => trial.safetyViolation === true).length,
    medianDurationMs: median(durations),
    p90DurationMs: percentileNearestRank(durations, 90),
    p95DurationMs: percentileNearestRank(durations, 95),
  };
}

/** Mean paired delta (treatment - control) per fixture over its completed pairs. */
function fixtureDeltas(
  pairs: readonly FixturePairRecord[],
): { fixtureId: string; value: number }[] {
  const perFixture = new Map<string, number[]>();
  for (const pair of pairs) {
    if (pair.controlSuccess === null || pair.treatmentSuccess === null) {
      continue;
    }
    const delta = Number(pair.treatmentSuccess) - Number(pair.controlSuccess);
    const existing = perFixture.get(pair.fixtureId) ?? [];
    existing.push(delta);
    perFixture.set(pair.fixtureId, existing);
  }
  return [...perFixture.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fixtureId, deltas]) => ({
      fixtureId,
      value: deltas.reduce((sum, value) => sum + value, 0) / deltas.length,
    }));
}

function secondaryComparison(
  trials: readonly TrialMetricInput[],
  controlArm: string,
  treatmentArm: string,
): Omit<SecondaryComparison, 'adjustedPValue'> {
  const pairs = buildPairTable(trials, controlArm, treatmentArm);
  const outcomes = pairedOutcomesFromTable(pairs);
  const signTest = pairedSignTest(outcomes);
  const controlSummary = summarizeArm(trials, controlArm);
  const treatmentSummary = summarizeArm(trials, treatmentArm);
  return {
    treatmentArm,
    completedPairs: outcomes.length,
    pairedSignTest: signTest,
    verifiedSuccessDelta:
      controlSummary.verifiedSuccessRate !== null && treatmentSummary.verifiedSuccessRate !== null
        ? treatmentSummary.verifiedSuccessRate - controlSummary.verifiedSuccessRate
        : null,
    rawPValue: signTest.pValueOneSided,
  };
}

function applyMultipleComparison(
  comparisons: readonly Omit<SecondaryComparison, 'adjustedPValue'>[],
  method: MultipleComparisonMethod,
  alpha: number,
): { holm: HolmCorrectionResult | null; comparisons: SecondaryComparison[] } {
  const testable = comparisons.filter(
    (entry): entry is Omit<SecondaryComparison, 'adjustedPValue'> & { rawPValue: number } =>
      entry.rawPValue !== null,
  );

  if (method === 'holm' && testable.length > 0) {
    const holm = applyHolmCorrection({
      comparisons: testable.map((entry) => ({ id: entry.treatmentArm, pValue: entry.rawPValue })),
      alpha,
    });
    return {
      holm,
      comparisons: comparisons.map((entry) => ({
        ...entry,
        adjustedPValue:
          holm.comparisons.find((adjusted) => adjusted.id === entry.treatmentArm)?.adjustedPValue ??
          null,
      })),
    };
  }

  if (method === 'bonferroni' && testable.length > 0) {
    const m = testable.length;
    return {
      holm: null,
      comparisons: comparisons.map((entry) => ({
        ...entry,
        adjustedPValue: entry.rawPValue === null ? null : Math.min(1, entry.rawPValue * m),
      })),
    };
  }

  return {
    holm: null,
    comparisons: comparisons.map((entry) => ({ ...entry, adjustedPValue: null })),
  };
}

function assessPower(input: {
  readonly discordantPairs: number;
  readonly minimumDiscordantPairs: number;
  readonly independentFixtureCount: number;
  readonly minimumDetectableDelta: number;
  readonly controlSuccessRate: number | null;
  readonly alpha: number;
}): PowerReadiness {
  const reasons: string[] = [];
  if (input.discordantPairs < input.minimumDiscordantPairs) {
    reasons.push(
      `discordant pairs ${String(input.discordantPairs)} < minimum ${String(input.minimumDiscordantPairs)}`,
    );
  }
  const fixtureWarning = assessPowerReadiness({
    independentFixtureCount: input.independentFixtureCount,
    minimumDetectableDelta: input.minimumDetectableDelta,
    alpha: input.alpha,
    ...(input.controlSuccessRate !== null ? { baselineSuccessRate: input.controlSuccessRate } : {}),
  });
  if (fixtureWarning !== null) {
    reasons.push(fixtureWarning.message);
  }
  return {
    version: POWER_READINESS_VERSION,
    discordantPairs: input.discordantPairs,
    minimumDiscordantPairs: input.minimumDiscordantPairs,
    independentFixtureCount: input.independentFixtureCount,
    minimumDetectableDelta: input.minimumDetectableDelta,
    lowPower: reasons.length > 0,
    reasons,
    fixtureWarning,
  };
}

/**
 * Compute the full experiment statistics from normalized trial records.
 *
 * - Pairs are fixture x repeatIndex; a pair counts only when both control and treatment trials
 *   are `completed`. Missing pairs are excluded from the sign test and counted separately.
 * - The paired sign test is one-sided (improvement) on discordant pairs.
 * - The cluster bootstrap resamples fixtures and reports a CI of the mean per-fixture delta.
 * - Secondary treatment arms receive Holm-adjusted p-values when requested.
 */
export function computeExperimentStatistics(input: ComputeStatisticsInput): ExperimentStatistics {
  const method = input.multipleComparisonMethod ?? 'none';
  const alpha = input.alpha ?? 0.05;
  const minimumDiscordantPairs = input.minimumDiscordantPairs ?? DEFAULT_MINIMUM_DISCORDANT_PAIRS;
  const minimumDetectableDelta = input.minimumDetectableDelta ?? DEFAULT_MINIMUM_DETECTABLE_DELTA;

  const pairs = buildPairTable(input.trials, input.controlArm, input.treatmentArm);
  const pairedOutcomes = pairedOutcomesFromTable(pairs);
  const signTest = pairedSignTest(pairedOutcomes);
  const completedPairs = pairedOutcomes.length;
  const plannedPairs = input.plannedPairs ?? pairs.length;
  const missingPairs = Math.max(0, plannedPairs - completedPairs);
  const discordantPairs = signTest.improvements + signTest.regressions;

  const armIds = [
    ...new Set([
      input.controlArm,
      input.treatmentArm,
      ...(input.secondaryTreatmentArms ?? []),
      ...input.trials.map((trial) => trial.armId),
    ]),
  ];
  const arms = armIds.map((armId) => summarizeArm(input.trials, armId));
  const control = summarizeArm(input.trials, input.controlArm);
  const treatment = summarizeArm(input.trials, input.treatmentArm);

  const infrastructureFailures = input.trials.filter((trial) => trial.infrastructureFailed).length;

  const bootstrap = clusterBootstrapCi({
    fixtureValues: fixtureDeltas(pairs),
    randomSeed: input.randomSeed ?? 'ael-cluster-bootstrap',
    ...(input.bootstrapIterations !== undefined ? { iterations: input.bootstrapIterations } : {}),
    ...(input.confidenceLevel !== undefined ? { confidenceLevel: input.confidenceLevel } : {}),
  });

  const secondaryRaw = (input.secondaryTreatmentArms ?? [])
    .filter((armId) => armId !== input.controlArm && armId !== input.treatmentArm)
    .map((armId) => secondaryComparison(input.trials, input.controlArm, armId));
  const { holm, comparisons: secondaryComparisons } = applyMultipleComparison(
    secondaryRaw,
    method,
    alpha,
  );

  const independentFixtureCount = new Set(input.trials.map((trial) => trial.fixtureId)).size;

  return {
    version: EXPERIMENT_STATISTICS_VERSION,
    independentFixtureCount,
    trialCount: input.trials.length,
    completedPairs,
    missingPairs,
    discordantPairs,
    pairedSignTest: signTest,
    verifiedSuccessDelta:
      control.verifiedSuccessRate !== null && treatment.verifiedSuccessRate !== null
        ? treatment.verifiedSuccessRate - control.verifiedSuccessRate
        : null,
    controlVerifiedSuccessRate: control.verifiedSuccessRate,
    treatmentVerifiedSuccessRate: treatment.verifiedSuccessRate,
    controlMedianDurationMs: control.medianDurationMs,
    treatmentMedianDurationMs: treatment.medianDurationMs,
    controlP90DurationMs: control.p90DurationMs,
    treatmentP90DurationMs: treatment.p90DurationMs,
    controlP95DurationMs: control.p95DurationMs,
    treatmentP95DurationMs: treatment.p95DurationMs,
    infrastructureFailureRate: computeRate(infrastructureFailures, input.trials.length),
    treatmentSafetyViolations: treatment.safetyViolationCount,
    pairs,
    arms,
    bootstrap,
    secondaryComparisons,
    holm,
    powerReadiness: assessPower({
      discordantPairs,
      minimumDiscordantPairs,
      independentFixtureCount,
      minimumDetectableDelta,
      controlSuccessRate: control.verifiedSuccessRate,
      alpha,
    }),
    methods: {
      signTest: PAIRED_SIGN_TEST_METHOD,
      bootstrap: bootstrap.method,
      multipleComparison: method,
    },
  };
}
