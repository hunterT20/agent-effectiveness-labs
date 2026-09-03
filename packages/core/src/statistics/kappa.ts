export const KAPPA_METHOD_VERSION = 'cohen-kappa-v1' as const;

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
  readonly raterCount: number;
  readonly packetCount: number;
}

function countByCategory(ratings: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rating of ratings) {
    counts.set(rating, (counts.get(rating) ?? 0) + 1);
  }
  return counts;
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
  const kappa = denominator === 0 ? null : (observedAgreement - expectedAgreement) / denominator;

  return {
    method: 'cohen-kappa',
    version: KAPPA_METHOD_VERSION,
    observedAgreement,
    expectedAgreement,
    kappa,
    raterCount: 2,
    packetCount: n,
  };
}

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
