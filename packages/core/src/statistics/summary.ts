/** Compute rate as numerator / denominator, or null when denominator is zero. */
export function computeRate(numerator: number, denominator: number): number | null {
  if (denominator === 0) {
    return null;
  }
  return numerator / denominator;
}

/** Nearest-rank percentile (P90/P95) on a sorted numeric array. */
export function percentileNearestRank(
  sortedValues: readonly number[],
  percentile: number,
): number | null {
  if (sortedValues.length === 0) {
    return null;
  }
  const rank = Math.ceil((percentile / 100) * sortedValues.length);
  const index = Math.max(0, Math.min(sortedValues.length - 1, rank - 1));
  return sortedValues[index] ?? null;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lower = sorted[middle - 1];
    const upper = sorted[middle];
    if (lower === undefined || upper === undefined) {
      return null;
    }
    return (lower + upper) / 2;
  }
  return sorted[middle] ?? null;
}

export function sortNumeric(values: readonly number[]): number[] {
  return [...values].sort((left, right) => left - right);
}

export interface PairedFixtureOutcome {
  readonly fixtureId: string;
  readonly controlSuccess: boolean;
  readonly treatmentSuccess: boolean;
}

export interface PairedSignTestResult {
  readonly improvements: number;
  readonly regressions: number;
  readonly ties: number;
  readonly pValueOneSided: number | null;
  readonly pValueTwoSided: number | null;
}

function binomialPmf(n: number, k: number, p: number): number {
  if (k < 0 || k > n) {
    return 0;
  }
  let coefficient = 1;
  for (let index = 1; index <= k; index += 1) {
    coefficient = (coefficient * (n - index + 1)) / index;
  }
  return coefficient * p ** k * (1 - p) ** (n - k);
}

function binomialTail(n: number, k: number, p: number): number {
  let probability = 0;
  for (let index = k; index <= n; index += 1) {
    probability += binomialPmf(n, index, p);
  }
  return probability;
}

/** Paired sign test for improvement (one-sided) and descriptive two-sided result. */
export function pairedSignTest(outcomes: readonly PairedFixtureOutcome[]): PairedSignTestResult {
  let improvements = 0;
  let regressions = 0;
  let ties = 0;

  for (const outcome of outcomes) {
    if (outcome.treatmentSuccess && !outcome.controlSuccess) {
      improvements += 1;
    } else if (!outcome.treatmentSuccess && outcome.controlSuccess) {
      regressions += 1;
    } else {
      ties += 1;
    }
  }

  const discordant = improvements + regressions;
  if (discordant === 0) {
    return {
      improvements,
      regressions,
      ties,
      pValueOneSided: null,
      pValueTwoSided: null,
    };
  }

  const pValueOneSided = binomialTail(discordant, improvements, 0.5);
  const pValueTwoSided = Math.min(
    1,
    2 * Math.min(pValueOneSided, binomialTail(discordant, regressions, 0.5)),
  );

  return {
    improvements,
    regressions,
    ties,
    pValueOneSided,
    pValueTwoSided,
  };
}

export type ExperimentVerdict = 'PASSED' | 'FAILED' | 'INSUFFICIENT_DATA';

export interface FixtureClusterSummary {
  readonly fixtureId: string;
  readonly controlSuccessRate: number | null;
  readonly treatmentSuccessRate: number | null;
  readonly controlMedianDurationMs: number | null;
  readonly treatmentMedianDurationMs: number | null;
}

export interface ExperimentStatistics {
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

export interface TrialMetricInput {
  readonly fixtureId: string;
  readonly armId: string;
  readonly repeatIndex: number;
  readonly verifiedSuccess: boolean;
  readonly infrastructureFailed: boolean;
  readonly durationMs: number | null;
}

export interface ComputeStatisticsInput {
  readonly controlArm: string;
  readonly treatmentArm: string;
  readonly trials: readonly TrialMetricInput[];
}

export function computeExperimentStatistics(input: ComputeStatisticsInput): ExperimentStatistics {
  const pairedOutcomes: PairedFixtureOutcome[] = [];
  const controlDurations: number[] = [];
  const treatmentDurations: number[] = [];
  let controlSuccesses = 0;
  let controlTotal = 0;
  let treatmentSuccesses = 0;
  let treatmentTotal = 0;
  let infrastructureFailures = 0;

  const fixtureKeys = new Set(
    input.trials.map((trial) => `${trial.fixtureId}:${String(trial.repeatIndex)}`),
  );

  for (const key of fixtureKeys) {
    const [fixtureId, repeatIndexRaw] = key.split(':');
    const repeatIndex = Number(repeatIndexRaw);
    const controlTrial = input.trials.find(
      (trial) =>
        trial.fixtureId === fixtureId &&
        trial.repeatIndex === repeatIndex &&
        trial.armId === input.controlArm,
    );
    const treatmentTrial = input.trials.find(
      (trial) =>
        trial.fixtureId === fixtureId &&
        trial.repeatIndex === repeatIndex &&
        trial.armId === input.treatmentArm,
    );
    if (controlTrial === undefined || treatmentTrial === undefined) {
      continue;
    }
    pairedOutcomes.push({
      fixtureId: fixtureId ?? '',
      controlSuccess: controlTrial.verifiedSuccess,
      treatmentSuccess: treatmentTrial.verifiedSuccess,
    });
  }

  for (const trial of input.trials) {
    if (trial.infrastructureFailed) {
      infrastructureFailures += 1;
    }
    if (trial.armId === input.controlArm) {
      controlTotal += 1;
      if (trial.verifiedSuccess) {
        controlSuccesses += 1;
      }
      if (trial.durationMs !== null) {
        controlDurations.push(trial.durationMs);
      }
    }
    if (trial.armId === input.treatmentArm) {
      treatmentTotal += 1;
      if (trial.verifiedSuccess) {
        treatmentSuccesses += 1;
      }
      if (trial.durationMs !== null) {
        treatmentDurations.push(trial.durationMs);
      }
    }
  }

  const controlRate = computeRate(controlSuccesses, controlTotal);
  const treatmentRate = computeRate(treatmentSuccesses, treatmentTotal);
  const sortedControlDurations = sortNumeric(controlDurations);
  const sortedTreatmentDurations = sortNumeric(treatmentDurations);

  return {
    independentFixtureCount: new Set(input.trials.map((trial) => trial.fixtureId)).size,
    trialCount: input.trials.length,
    pairedSignTest: pairedSignTest(pairedOutcomes),
    verifiedSuccessDelta:
      controlRate !== null && treatmentRate !== null ? treatmentRate - controlRate : null,
    controlVerifiedSuccessRate: controlRate,
    treatmentVerifiedSuccessRate: treatmentRate,
    controlMedianDurationMs: median(sortedControlDurations),
    treatmentMedianDurationMs: median(sortedTreatmentDurations),
    controlP90DurationMs: percentileNearestRank(sortedControlDurations, 90),
    treatmentP90DurationMs: percentileNearestRank(sortedTreatmentDurations, 90),
    controlP95DurationMs: percentileNearestRank(sortedControlDurations, 95),
    treatmentP95DurationMs: percentileNearestRank(sortedTreatmentDurations, 95),
    infrastructureFailureRate: computeRate(infrastructureFailures, input.trials.length),
  };
}
