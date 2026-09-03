export const HOLM_CORRECTION_VERSION = 'holm-v1' as const;

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

/** Deterministic Holm step-down correction for secondary arm comparisons. */
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
  let stop = false;

  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index];
    if (entry === undefined) {
      continue;
    }
    const rank = index + 1;
    const threshold = alpha / (m - index);
    const adjustedPValue = Math.min(1, entry.pValue * (m - index + 1));
    const significant = !stop && entry.pValue <= threshold;
    if (!significant) {
      stop = true;
    }
    comparisons.push({
      id: entry.id,
      rawPValue: entry.pValue,
      adjustedPValue,
      significant,
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
