import { describe, expect, it } from 'vitest';

import { PricingSnapshotSchema } from '@ael/core';
import {
  aggregateTelemetryPhases,
  computeTelemetryCost,
  estimateAdvisoryExposure,
  extractCursorTelemetry,
  loadPricingSnapshot,
} from '@ael/runtime';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const examplesRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../examples/minimal');

describe('telemetry pricing and provenance', () => {
  it('loads pricing snapshot with fingerprint', () => {
    const pricing = loadPricingSnapshot(examplesRoot);
    expect(pricing.schemaVersion).toBe(1);
    expect(pricing.models['composer-2.5']).toBeDefined();
    expect(PricingSnapshotSchema.parse(pricing)).toBeTruthy();
  });

  it('computes cost only when required components are available', () => {
    const pricing = loadPricingSnapshot(examplesRoot);
    const telemetry = extractCursorTelemetry(
      '{"type":"result","usage":{"input_tokens":1000000,"output_tokens":1000000}}',
    ).telemetry;
    const cost = computeTelemetryCost(telemetry, 'composer-2.5', pricing);
    expect(cost.quality).toBe('exact');
    expect(cost.value).toBe(18);
  });

  it('returns unavailable cost when model is missing from pricing', () => {
    const pricing = loadPricingSnapshot(examplesRoot);
    const telemetry = extractCursorTelemetry(
      '{"type":"result","usage":{"input_tokens":1,"output_tokens":1}}',
    ).telemetry;
    const cost = computeTelemetryCost(telemetry, 'unknown-model', pricing);
    expect(cost.quality).toBe('unavailable');
    expect(cost.value).toBeNull();
  });

  it('aggregates phase telemetry and keeps failed-phase usage', () => {
    const phaseA = extractCursorTelemetry(
      '{"type":"result","usage":{"input_tokens":100,"output_tokens":50}}',
    ).telemetry;
    const phaseB = extractCursorTelemetry('').telemetry;
    const aggregated = aggregateTelemetryPhases([phaseA, phaseB]);
    expect(aggregated.inputTokens.value).toBe(100);
    expect(aggregated.outputTokens.coverageReason).toContain('partial');
  });

  it('estimates advisory exposure for plan output', () => {
    const pricing = loadPricingSnapshot(examplesRoot);
    const advisory = estimateAdvisoryExposure({
      trialPlanAgentInvocations: 6,
      model: 'composer-2.5',
      pricing,
      assumedInputTokensPerInvocation: 50_000,
      assumedOutputTokensPerInvocation: 10_000,
    });
    expect(advisory.quality).toBe('estimated');
    expect(advisory.value).toBeGreaterThan(0);
  });
});
