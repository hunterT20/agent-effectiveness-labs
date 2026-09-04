export const HOLM_CORRECTION_VERSION = 'holm-v2' as const;

export interface HolmComparisonInput {
  readonly id: string;
  readonly pValue: number;
}

export interface HolmComparisonResult {
  readonly id: string;
  readonly rawPValue: number;
  readonly adjustedPValue: number;
  readonly significant: boolean;
  readonly rank: number;
}

export interface HolmCorrectionInput {
  readonly comparisons: readonly HolmComparisonInput[];
  readonly alpha?: number;
}

export interface HolmCorrectionResult {
  readonly method: 'holm';
  readonly version: typeof HOLM_CORRECTION_VERSION;
  readonly alpha: number;
  readonly comparisons: readonly HolmComparisonResult[];
}

/**
 * Deterministic Holm step-down correction for secondary arm comparisons.
 *
 * With p-values sorted ascending p_(1) <= ... <= p_(m) (1-based rank i), the adjusted p-value is
 * `max_{j <= i} min(1, (m - j + 1) * p_(j))`: the raw step-down factor `(m - i + 1)` followed by a
 * cumulative maximum so adjusted values are monotone non-decreasing in rank. A comparison is
 * significant when its adjusted p-value is `<= alpha`, which is equivalent to the classic
 * step-down stopping rule.
 */
export function applyHolmCorrection(input: HolmCorrectionInput): HolmCorrectionResult {
  const alpha = input.alpha ?? 0.05;
  const ordered = [...input.comparisons].sort((left, right) => {
    if (left.pValue !== right.pValue) {
      return left.pValue - right.pValue;
    }
    return left.id.localeCompare(right.id);
  });

  const m = ordered.length;
  const comparisons: HolmComparisonResult[] = [];
  let runningMax = 0;

  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index];
    if (entry === undefined) {
      continue;
    }
    const rank = index + 1;
    const stepDown = Math.min(1, entry.pValue * (m - rank + 1));
    runningMax = Math.max(runningMax, stepDown);
    const adjustedPValue = runningMax;
    comparisons.push({
      id: entry.id,
      rawPValue: entry.pValue,
      adjustedPValue,
      significant: adjustedPValue <= alpha,
      rank,
    });
  }

  return {
    method: 'holm',
    version: HOLM_CORRECTION_VERSION,
    alpha,
    comparisons,
  };
}
