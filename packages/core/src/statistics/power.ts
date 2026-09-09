/**
 * v2: paired-binary (McNemar / sign test) sample size per Connor (1987), replacing the v1
 * approximation that ignored the effect size in the denominator and under-estimated by ~10x.
 */
export const POWER_READINESS_VERSION = 'power-readiness-v2' as const;

export interface PowerReadinessInput {
  readonly independentFixtureCount: number;
  readonly minimumDetectableDelta: number;
  readonly baselineSuccessRate?: number;
  readonly alpha?: number;
  readonly power?: number;
}

export interface PowerReadinessWarning {
  readonly code: 'UNDERPOWERED';
  readonly message: string;
  readonly requiredFixtureCount: number;
  readonly plannedFixtureCount: number;
  readonly minimumDetectableDelta: number;
}

function normalQuantile(probability: number): number {
  if (probability <= 0 || probability >= 1) {
    return 0;
  }
  // Rational approximation for inverse normal CDF (Abramowitz & Stegun 26.2.23)
  const t = Math.sqrt(-2 * Math.log(probability < 0.5 ? probability : 1 - probability));
  const c = [2.515517, 0.802853, 0.010328];
  const d = [1.432788, 0.189269, 0.001308];
  const numerator = (c[0] ?? 0) + (c[1] ?? 0) * t + (c[2] ?? 0) * t * t;
  const denominator = 1 + (d[0] ?? 0) * t + (d[1] ?? 0) * t * t + (d[2] ?? 0) * t * t * t;
  const value = t - numerator / denominator;
  return probability < 0.5 ? -value : value;
}

/**
 * Approximate number of paired fixtures needed for a one-sided paired sign / McNemar test to
 * detect `minimumDetectableDelta` in verified-success rate at the given alpha and power.
 *
 * Assumes independence between arms within a fixture so the discordant proportion is
 * `pd = b(1 - t) + (1 - b)t` with `b` the baseline rate and `t = min(1, b + delta)`.
 * Sample size: `n = (z_a * sqrt(pd) + z_b * sqrt(pd - delta^2))^2 / delta^2`.
 */
export function estimateRequiredFixtureCount(input: PowerReadinessInput): number {
  const baseline = Math.min(1, Math.max(0, input.baselineSuccessRate ?? 0.5));
  const alpha = input.alpha ?? 0.05;
  const power = input.power ?? 0.8;
  const treatment = Math.min(1, Math.max(0, baseline + input.minimumDetectableDelta));
  const delta = treatment - baseline;
  if (delta <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const discordantRate = baseline * (1 - treatment) + (1 - baseline) * treatment;
  if (discordantRate <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const zAlpha = normalQuantile(1 - alpha);
  const zBeta = normalQuantile(power);
  const tail = Math.sqrt(Math.max(0, discordantRate - delta * delta));
  const numerator = (zAlpha * Math.sqrt(discordantRate) + zBeta * tail) ** 2;
  return Math.max(1, Math.ceil(numerator / (delta * delta)));
}

export function assessPowerReadiness(input: PowerReadinessInput): PowerReadinessWarning | null {
  const requiredFixtureCount = estimateRequiredFixtureCount(input);
  if (!Number.isFinite(requiredFixtureCount)) {
    return {
      code: 'UNDERPOWERED',
      message: 'Requested effect size is not detectable with any finite fixture count',
      requiredFixtureCount: Number.POSITIVE_INFINITY,
      plannedFixtureCount: input.independentFixtureCount,
      minimumDetectableDelta: input.minimumDetectableDelta,
    };
  }
  if (input.independentFixtureCount < requiredFixtureCount) {
    return {
      code: 'UNDERPOWERED',
      message: `Planned fixtures (${String(input.independentFixtureCount)}) are below the estimated requirement (${String(requiredFixtureCount)}) for delta ${String(input.minimumDetectableDelta)}`,
      requiredFixtureCount,
      plannedFixtureCount: input.independentFixtureCount,
      minimumDetectableDelta: input.minimumDetectableDelta,
    };
  }
  return null;
}
