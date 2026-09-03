import { createMulberry32, derivePrngSeed } from '../scheduler/prng.js';
import { median, sortNumeric } from './summary.js';

export const CLUSTER_BOOTSTRAP_VERSION = 'cluster-bootstrap-v1' as const;
export const CLUSTER_BOOTSTRAP_METHOD = 'percentile-cluster-resample' as const;

export interface FixtureClusterValue {
  readonly fixtureId: string;
  readonly value: number;
}

export interface ClusterBootstrapInput {
  readonly fixtureValues: readonly FixtureClusterValue[];
  readonly randomSeed: string;
  readonly iterations?: number;
  readonly confidenceLevel?: number;
}

export interface ClusterBootstrapResult {
  readonly method: typeof CLUSTER_BOOTSTRAP_METHOD;
  readonly version: typeof CLUSTER_BOOTSTRAP_VERSION;
  readonly iterations: number;
  readonly confidenceLevel: number;
  readonly pointEstimate: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly resampledFixtureCount: number;
}

function percentile(sortedValues: readonly number[], percentileValue: number): number | null {
  if (sortedValues.length === 0) {
    return null;
  }
  const rank = Math.ceil((percentileValue / 100) * sortedValues.length);
  const index = Math.max(0, Math.min(sortedValues.length - 1, rank - 1));
  return sortedValues[index] ?? null;
}

/** Cluster bootstrap CI by resampling whole fixtures with a deterministic seed. */
export function clusterBootstrapCi(input: ClusterBootstrapInput): ClusterBootstrapResult {
  const iterations = input.iterations ?? 2000;
  const confidenceLevel = input.confidenceLevel ?? 0.95;
  const fixtureValues = input.fixtureValues;

  if (fixtureValues.length === 0) {
    return {
      method: CLUSTER_BOOTSTRAP_METHOD,
      version: CLUSTER_BOOTSTRAP_VERSION,
      iterations,
      confidenceLevel,
      pointEstimate: null,
      lower: null,
      upper: null,
      resampledFixtureCount: 0,
    };
  }

  const pointEstimate = median(fixtureValues.map((entry) => entry.value));
  const rng = createMulberry32(derivePrngSeed(input.randomSeed));
  const bootstrapMeans: number[] = [];

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const resampled: number[] = [];
    for (let draw = 0; draw < fixtureValues.length; draw += 1) {
      const index = Math.floor(rng() * fixtureValues.length);
      const selected = fixtureValues[index];
      if (selected !== undefined) {
        resampled.push(selected.value);
      }
    }
    const mean = resampled.reduce((sum, value) => sum + value, 0) / resampled.length;
    bootstrapMeans.push(mean);
  }

  const alpha = (1 - confidenceLevel) / 2;
  const sortedMeans = sortNumeric(bootstrapMeans);

  return {
    method: CLUSTER_BOOTSTRAP_METHOD,
    version: CLUSTER_BOOTSTRAP_VERSION,
    iterations,
    confidenceLevel,
    pointEstimate,
    lower: percentile(sortedMeans, alpha * 100),
    upper: percentile(sortedMeans, (1 - alpha) * 100),
    resampledFixtureCount: fixtureValues.length,
  };
}
