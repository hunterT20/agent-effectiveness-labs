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

