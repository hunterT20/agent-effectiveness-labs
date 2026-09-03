export const POWER_READINESS_VERSION = 'power-readiness-v1' as const;

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

/** Approximate paired sign-test sample size for a binary success delta. */
export function estimateRequiredFixtureCount(input: PowerReadinessInput): number {
  const baseline = input.baselineSuccessRate ?? 0.5;
  const delta = input.minimumDetectableDelta;
  const alpha = input.alpha ?? 0.05;
  const power = input.power ?? 0.8;
  const treatment = Math.min(1, Math.max(0, baseline + delta));
  const discordantRate = baseline * (1 - treatment) + (1 - baseline) * treatment;
  if (discordantRate <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const zAlpha = normalQuantile(1 - alpha);
  const zBeta = normalQuantile(power);
  const numerator = (zAlpha + zBeta) ** 2;
  return Math.ceil(numerator / (4 * discordantRate ** 2));
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
