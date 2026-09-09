import { describe, expect, it } from 'vitest';

import { TrialTelemetrySchema } from '@ael/core';

describe('telemetry contracts', () => {
  it('accepts trial telemetry with provenance fields', () => {
    const record = TrialTelemetrySchema.parse({
      schemaVersion: 1,
      inputTokens: {
        value: 10,
        quality: 'exact',
        source: 'cursor-stream-json',
        coverageReason: null,
      },
      outputTokens: {
        value: 5,
        quality: 'exact',
        source: 'cursor-stream-json',
        coverageReason: null,
      },
      cachedInputTokens: {
        value: null,
        quality: 'unavailable',
        source: 'cursor-stream-json',
        coverageReason: 'missing',
      },
      reasoningTokens: {
        value: null,
        quality: 'unavailable',
        source: 'cursor-stream-json',
        coverageReason: 'missing',
      },
      subagentTokens: {
        value: null,
        quality: 'unavailable',
        source: 'cursor-stream-json',
        coverageReason: 'missing',
      },
      toolCalls: { value: 1, quality: 'exact', source: 'cursor-stream-json', coverageReason: null },
      estimatedCostUsd: {
        value: null,
        quality: 'unavailable',
        source: 'pricing-snapshot',
        coverageReason: 'unpriced',
      },
      phaseCount: 1,
      rawArtifactPath: '/tmp/stdout.log',
    });
    expect(record.phaseCount).toBe(1);
  });
});
