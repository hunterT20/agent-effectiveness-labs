import type {
  AgentTelemetry,
  MetricValue,
  TelemetryCoverageSummary,
  TrialTelemetry,
} from '@ael/core';

function aggregateNumericMetric(
  phases: readonly AgentTelemetry[],
  field: keyof AgentTelemetry,
): MetricValue<number> {
  let total = 0;
  let hasExact = false;
  let hasEstimated = false;
  let hasUnavailable = false;
  const sources = new Set<string>();

  for (const phase of phases) {
    const metric = phase[field];
    sources.add(metric.source ?? 'unknown');
    if (metric.quality === 'unavailable' || metric.value === null) {
      hasUnavailable = true;
      continue;
    }
    if (metric.quality === 'estimated') {
      hasEstimated = true;
    } else {
      hasExact = true;
    }
    total += metric.value;
  }

  if (!hasExact && !hasEstimated) {
    return {
      value: null,
      quality: 'unavailable',
      source: [...sources].join('+') || null,
      coverageReason: 'all phases unavailable',
    };
  }

  return {
    value: total,
    quality: hasEstimated && !hasExact ? 'estimated' : hasEstimated ? 'estimated' : 'exact',
    source: [...sources].join('+') || null,
    coverageReason: hasUnavailable ? 'partial phase coverage' : null,
  };
}

export function aggregateTelemetryPhases(phases: readonly AgentTelemetry[]): AgentTelemetry {
  return {
    inputTokens: aggregateNumericMetric(phases, 'inputTokens'),
    outputTokens: aggregateNumericMetric(phases, 'outputTokens'),
    cachedInputTokens: aggregateNumericMetric(phases, 'cachedInputTokens'),
    reasoningTokens: aggregateNumericMetric(phases, 'reasoningTokens'),
    subagentTokens: aggregateNumericMetric(phases, 'subagentTokens'),
    toolCalls: aggregateNumericMetric(phases, 'toolCalls'),
  };
}

export function summarizeTelemetryCoverage(telemetry: AgentTelemetry): TelemetryCoverageSummary {
  const metrics = [
    telemetry.inputTokens,
    telemetry.outputTokens,
    telemetry.cachedInputTokens,
    telemetry.reasoningTokens,
    telemetry.subagentTokens,
    telemetry.toolCalls,
  ];
  let exact = 0;
  let estimated = 0;
  let unavailable = 0;
  for (const metric of metrics) {
    if (metric.quality === 'exact') {
      exact += 1;
    } else if (metric.quality === 'estimated') {
      estimated += 1;
    } else {
      unavailable += 1;
    }
  }
  return { exact, estimated, unavailable, total: metrics.length };
}

export function buildTrialTelemetryRecord(input: {
  readonly telemetry: AgentTelemetry;
  readonly estimatedCostUsd: MetricValue<number>;
  readonly phaseCount: number;
  readonly rawArtifactPath: string | null;
}): TrialTelemetry {
  return {
    schemaVersion: 1,
    inputTokens: input.telemetry.inputTokens,
    outputTokens: input.telemetry.outputTokens,
    cachedInputTokens: input.telemetry.cachedInputTokens,
    reasoningTokens: input.telemetry.reasoningTokens,
    subagentTokens: input.telemetry.subagentTokens,
    toolCalls: input.telemetry.toolCalls,
    estimatedCostUsd: input.estimatedCostUsd,
    phaseCount: input.phaseCount,
    rawArtifactPath: input.rawArtifactPath,
  };
}
