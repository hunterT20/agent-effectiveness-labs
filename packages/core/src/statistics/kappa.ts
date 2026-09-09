export const KAPPA_METHOD_VERSION = 'cohen-kappa-v1' as const;
export const FLEISS_KAPPA_METHOD_VERSION = 'fleiss-kappa-v1' as const;
export const PERCENT_AGREEMENT_METHOD_VERSION = 'percent-agreement-v1' as const;

export interface RaterRating {
  readonly raterId: string;
  readonly packetId: string;
  readonly category: string;
}

export interface CohenKappaResult {
  readonly method: 'cohen-kappa';
  readonly version: typeof KAPPA_METHOD_VERSION;
  readonly observedAgreement: number;
  readonly expectedAgreement: number;
  readonly kappa: number | null;
  /** Explains a degenerate result (`kappa === null` or a forced value). */
  readonly reason: string | null;
  readonly raterCount: number;
  readonly packetCount: number;
}

export interface FleissKappaResult {
  readonly method: 'fleiss-kappa';
  readonly version: typeof FLEISS_KAPPA_METHOD_VERSION;
  readonly observedAgreement: number;
  readonly expectedAgreement: number;
  readonly kappa: number | null;
  readonly reason: string | null;
  readonly raterCount: number;
  readonly packetCount: number;
}

export interface PercentAgreementResult {
  readonly method: 'percent-agreement';
  readonly version: typeof PERCENT_AGREEMENT_METHOD_VERSION;
  readonly observedAgreement: number;
  readonly packetCount: number;
}

export const KAPPA_REASON_NO_PACKETS = 'no packets rated by at least two raters';
export const KAPPA_REASON_ALL_IDENTICAL =
  'all ratings identical; chance-corrected kappa is undefined and reported as 1';
export const KAPPA_REASON_UNDEFINED = 'expected agreement equals 1; kappa undefined';
export const KAPPA_REASON_UNEQUAL_RATERS = 'packets have unequal rater counts';
export const KAPPA_REASON_TOO_FEW_RATERS = 'every packet needs at least two raters';

function countByCategory(ratings: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rating of ratings) {
    counts.set(rating, (counts.get(rating) ?? 0) + 1);
  }
  return counts;
}

/**
 * Resolves the degenerate `1 - expected === 0` case shared by Cohen and Fleiss.
 * Expected agreement can only reach 1 when every rating uses a single category,
 * which implies perfect observed agreement; report 1 with an explicit reason.
 */
function resolveDegenerateKappa(observedAgreement: number): {
  readonly kappa: number | null;
  readonly reason: string;
} {
  if (observedAgreement === 1) {
    return { kappa: 1, reason: KAPPA_REASON_ALL_IDENTICAL };
  }
  return { kappa: null, reason: KAPPA_REASON_UNDEFINED };
}

/** Cohen's kappa for two raters on blinded rubric packets. */
export function cohenKappa(
  leftRatings: readonly string[],
  rightRatings: readonly string[],
): CohenKappaResult {
  const n = Math.min(leftRatings.length, rightRatings.length);
  if (n === 0) {
    return {
      method: 'cohen-kappa',
      version: KAPPA_METHOD_VERSION,
      observedAgreement: 0,
      expectedAgreement: 0,
      kappa: null,
      reason: KAPPA_REASON_NO_PACKETS,
      raterCount: 2,
      packetCount: 0,
    };
  }

  let agree = 0;
  for (let index = 0; index < n; index += 1) {
    if (leftRatings[index] === rightRatings[index]) {
      agree += 1;
    }
  }
  const observedAgreement = agree / n;

  const leftCounts = countByCategory(leftRatings.slice(0, n));
  const rightCounts = countByCategory(rightRatings.slice(0, n));
  const categories = new Set([...leftCounts.keys(), ...rightCounts.keys()]);
  let expectedAgreement = 0;
  for (const category of categories) {
    expectedAgreement +=
      ((leftCounts.get(category) ?? 0) / n) * ((rightCounts.get(category) ?? 0) / n);
  }

  const denominator = 1 - expectedAgreement;
  if (denominator <= Number.EPSILON) {
    const degenerate = resolveDegenerateKappa(observedAgreement);
    return {
      method: 'cohen-kappa',
      version: KAPPA_METHOD_VERSION,
      observedAgreement,
      expectedAgreement,
      kappa: degenerate.kappa,
      reason: degenerate.reason,
      raterCount: 2,
      packetCount: n,
    };
  }

  return {
    method: 'cohen-kappa',
    version: KAPPA_METHOD_VERSION,
    observedAgreement,
    expectedAgreement,
    kappa: (observedAgreement - expectedAgreement) / denominator,
    reason: null,
    raterCount: 2,
    packetCount: n,
  };
}

function fleissDegenerate(
  reason: string,
  packetCount: number,
  raterCount: number,
): FleissKappaResult {
  return {
    method: 'fleiss-kappa',
    version: FLEISS_KAPPA_METHOD_VERSION,
    observedAgreement: 0,
    expectedAgreement: 0,
    kappa: null,
    reason,
    raterCount,
    packetCount,
  };
}

/**
 * Fleiss' kappa for a fixed number of raters per packet.
 *
 * `ratings[i]` holds the categorical labels assigned to packet `i`, one per rater.
 * Raters need not be the same people across packets, but every packet must have
 * the same number of raters (>= 2). Violations yield `kappa: null` with a reason
 * instead of silently dropping data.
 */
export function fleissKappa(ratings: ReadonlyArray<ReadonlyArray<string>>): FleissKappaResult {
  const packetCount = ratings.length;
  if (packetCount === 0) {
    return fleissDegenerate(KAPPA_REASON_NO_PACKETS, 0, 0);
  }
  const firstRow = ratings[0];
  const raterCount = firstRow === undefined ? 0 : firstRow.length;
  if (raterCount < 2) {
    return fleissDegenerate(KAPPA_REASON_TOO_FEW_RATERS, packetCount, raterCount);
  }
  if (ratings.some((row) => row.length !== raterCount)) {
    return fleissDegenerate(KAPPA_REASON_UNEQUAL_RATERS, packetCount, raterCount);
  }

  const categoryTotals = new Map<string, number>();
  let observedSum = 0;
  for (const row of ratings) {
    const counts = countByCategory(row);
    let squares = 0;
    for (const [category, count] of counts) {
      squares += count * count;
      categoryTotals.set(category, (categoryTotals.get(category) ?? 0) + count);
    }
    observedSum += (squares - raterCount) / (raterCount * (raterCount - 1));
  }
  const observedAgreement = observedSum / packetCount;

  const totalRatings = packetCount * raterCount;
  let expectedAgreement = 0;
  for (const total of categoryTotals.values()) {
    const proportion = total / totalRatings;
    expectedAgreement += proportion * proportion;
  }

  const denominator = 1 - expectedAgreement;
  if (denominator <= Number.EPSILON) {
    const degenerate = resolveDegenerateKappa(observedAgreement);
    return {
      method: 'fleiss-kappa',
      version: FLEISS_KAPPA_METHOD_VERSION,
      observedAgreement,
      expectedAgreement,
      kappa: degenerate.kappa,
      reason: degenerate.reason,
      raterCount,
      packetCount,
    };
  }

  return {
    method: 'fleiss-kappa',
    version: FLEISS_KAPPA_METHOD_VERSION,
    observedAgreement,
    expectedAgreement,
    kappa: (observedAgreement - expectedAgreement) / denominator,
    reason: null,
    raterCount,
    packetCount,
  };
}

/**
 * Mean pairwise percent agreement across packets with a variable number of raters.
 * Not chance-corrected; used only as a documented fallback when kappa is not defined
 * for the rating design (for example unequal rater counts per packet).
 */
export function pairwisePercentAgreement(
  ratings: ReadonlyArray<ReadonlyArray<string>>,
): PercentAgreementResult {
  let total = 0;
  let counted = 0;
  for (const row of ratings) {
    if (row.length < 2) {
      continue;
    }
    let pairs = 0;
    let agreeing = 0;
    for (let left = 0; left < row.length; left += 1) {
      for (let right = left + 1; right < row.length; right += 1) {
        pairs += 1;
        if (row[left] === row[right]) {
          agreeing += 1;
        }
      }
    }
    total += agreeing / pairs;
    counted += 1;
  }
  return {
    method: 'percent-agreement',
    version: PERCENT_AGREEMENT_METHOD_VERSION,
    observedAgreement: counted === 0 ? 0 : total / counted,
    packetCount: counted,
  };
}

/**
 * Two-rater convenience wrapper: pairs the first two rater ids (sorted) per packet.
 * Prefer `fleissKappa` when more than two raters are involved.
 */
export function interRaterAgreementForPackets(
  ratings: readonly RaterRating[],
): CohenKappaResult | null {
  const byPacket = new Map<string, Map<string, string>>();
  for (const rating of ratings) {
    const packetRatings = byPacket.get(rating.packetId) ?? new Map<string, string>();
    packetRatings.set(rating.raterId, rating.category);
    byPacket.set(rating.packetId, packetRatings);
  }

  const raterIds = [...new Set(ratings.map((entry) => entry.raterId))].sort();
  if (raterIds.length < 2) {
    return null;
  }

  const leftRater = raterIds[0];
  const rightRater = raterIds[1];
  if (leftRater === undefined || rightRater === undefined) {
    return null;
  }
  const leftRatings: string[] = [];
  const rightRatings: string[] = [];
  for (const packetRatings of byPacket.values()) {
    const left = packetRatings.get(leftRater);
    const right = packetRatings.get(rightRater);
    if (left !== undefined && right !== undefined) {
      leftRatings.push(left);
      rightRatings.push(right);
    }
  }

  return cohenKappa(leftRatings, rightRatings);
}
