import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { AgentTelemetry, MetricValue, PricingSnapshot } from '@ael/core';
import { computeFingerprint } from '@ael/core';

import { aggregateTelemetryPhases } from './aggregate.js';

const PricingYamlSchema = {
  parse(raw: unknown, sourcePath: string): PricingSnapshot {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`invalid pricing snapshot: ${sourcePath}`);
    }
    const record = raw as Record<string, unknown>;
    if (record.schemaVersion !== 1) {
      throw new Error(`unsupported pricing schema in ${sourcePath}`);
    }
    const currency = typeof record.currency === 'string' ? record.currency : 'USD';
    const effectiveAt = typeof record.effectiveAt === 'string' ? record.effectiveAt : '';
    const modelsRaw = record.models;
    if (typeof modelsRaw !== 'object' || modelsRaw === null) {
      throw new Error(`pricing models missing in ${sourcePath}`);
    }
    const models: PricingSnapshot['models'] = {};
    for (const [modelId, entry] of Object.entries(modelsRaw)) {
      if (typeof entry !== 'object' || entry === null) {
        continue;
      }
      const modelRecord = entry as Record<string, unknown>;
      const componentsRaw = modelRecord.components;
      if (typeof componentsRaw !== 'object' || componentsRaw === null) {
        continue;
      }
      const components = componentsRaw as Record<string, unknown>;
      models[modelId] = {
        provider: typeof modelRecord.provider === 'string' ? modelRecord.provider : 'unknown',
        components: {
          inputPerMillion:
            typeof components.inputPerMillion === 'number' ? components.inputPerMillion : null,
          outputPerMillion:
            typeof components.outputPerMillion === 'number' ? components.outputPerMillion : null,
          cachedInputPerMillion:
            typeof components.cachedInputPerMillion === 'number'
              ? components.cachedInputPerMillion
              : null,
          reasoningPerMillion:
            typeof components.reasoningPerMillion === 'number'
              ? components.reasoningPerMillion
              : null,
        },
      };
    }
    const withoutFingerprint = {
      schemaVersion: 1 as const,
      currency,
      effectiveAt,
      sourcePath,
      models,
    };
    return {
      ...withoutFingerprint,
      fingerprint: computeFingerprint(withoutFingerprint),
    };
  },
};

export function defaultPricingPath(suiteRoot: string): string {
  return join(suiteRoot, 'pricing.yaml');
}

export function loadPricingSnapshot(suiteRoot: string, explicitPath?: string): PricingSnapshot {
  const sourcePath = explicitPath ?? defaultPricingPath(suiteRoot);
  const raw: unknown = parseYaml(readFileSync(sourcePath, 'utf8'));
  return PricingYamlSchema.parse(raw, sourcePath);
}

export function computeTelemetryCost(
  telemetry: AgentTelemetry,
  model: string,
  pricing: PricingSnapshot,
): MetricValue<number> {
  const modelPricing = pricing.models[model];
  if (modelPricing === undefined) {
    return {
      value: null,
      quality: 'unavailable',
      source: 'pricing-snapshot',
      coverageReason: `no pricing entry for model ${model}`,
    };
  }

  const required: Array<{ metric: MetricValue<number>; rate: number | null; label: string }> = [
    {
      metric: telemetry.inputTokens,
      rate: modelPricing.components.inputPerMillion,
      label: 'input',
    },
    {
      metric: telemetry.outputTokens,
      rate: modelPricing.components.outputPerMillion,
      label: 'output',
    },
  ];

  for (const component of required) {
    if (component.metric.quality === 'unavailable' || component.metric.value === null) {
      return {
        value: null,
        quality: 'unavailable',
        source: 'pricing-snapshot',
        coverageReason: `${component.label} tokens unavailable`,
      };
    }
    if (component.rate === null) {
      return {
        value: null,
        quality: 'unavailable',
        source: 'pricing-snapshot',
        coverageReason: `${component.label} rate unavailable in pricing snapshot`,
      };
    }
  }

  // Cost quality rules (see docs/telemetry.md):
  //   - `unavailable` when input/output tokens or their rates are missing (handled above);
  //   - `estimated` when any token component that *was* measured (non-null value) has no rate,
  //     or when any priced component is itself only `estimated`;
  //   - `exact` only when every measured component is exact and priced.
  const unpricedComponents: string[] = [];
  const estimatedComponents: string[] = [];
  let total = 0;

  const priced: Array<{ metric: MetricValue<number>; rate: number | null; label: string }> = [
    ...required,
    {
      metric: telemetry.cachedInputTokens,
      rate: modelPricing.components.cachedInputPerMillion,
      label: 'cachedInput',
    },
    {
      metric: telemetry.reasoningTokens,
      rate: modelPricing.components.reasoningPerMillion,
      label: 'reasoning',
    },
    { metric: telemetry.subagentTokens, rate: null, label: 'subagent' },
  ];

  for (const component of priced) {
    if (component.metric.value === null || component.metric.quality === 'unavailable') {
      continue;
    }
    if (component.rate === null) {
      if (component.metric.value > 0) {
        unpricedComponents.push(component.label);
      }
      continue;
    }
    if (component.metric.quality === 'estimated') {
      estimatedComponents.push(component.label);
    }
    total += (component.metric.value * component.rate) / 1_000_000;
  }

  const reasons: string[] = [];
  if (unpricedComponents.length > 0) {
    reasons.push(`no price for measured ${unpricedComponents.join(', ')} tokens`);
  }
  if (estimatedComponents.length > 0) {
    reasons.push(`${estimatedComponents.join(', ')} tokens are estimated`);
  }

  return {
    value: total,
    quality: reasons.length > 0 ? 'estimated' : 'exact',
    source: 'pricing-snapshot',
    coverageReason: reasons.length > 0 ? reasons.join('; ') : null,
  };
}

export function resolveSuitePricingPath(suiteRoot: string): string | null {
  const candidate = defaultPricingPath(suiteRoot);
  try {
    readFileSync(candidate, 'utf8');
    return candidate;
  } catch {
    return null;
  }
}

export function pricingFingerprintForSuite(suiteRoot: string): string {
  const path = resolveSuitePricingPath(suiteRoot);
  if (path === null) {
    return 'unpriced';
  }
  return loadPricingSnapshot(suiteRoot, path).fingerprint;
}

export function estimateAdvisoryExposure(input: {
  readonly trialPlanAgentInvocations: number;
  readonly model: string;
  readonly pricing: PricingSnapshot | null;
  readonly assumedInputTokensPerInvocation: number;
  readonly assumedOutputTokensPerInvocation: number;
}): MetricValue<number> {
  if (input.pricing === null) {
    return {
      value: null,
      quality: 'unavailable',
      source: 'pricing-snapshot',
      coverageReason: 'no pricing snapshot available',
    };
  }
  const modelPricing = input.pricing.models[input.model];
  if (modelPricing === undefined) {
    return {
      value: null,
      quality: 'unavailable',
      source: 'pricing-snapshot',
      coverageReason: `no pricing entry for model ${input.model}`,
    };
  }
  const inputRate = modelPricing.components.inputPerMillion;
  const outputRate = modelPricing.components.outputPerMillion;
  if (inputRate === null || outputRate === null) {
    return {
      value: null,
      quality: 'unavailable',
      source: 'pricing-snapshot',
      coverageReason: 'required pricing components unavailable',
    };
  }
  const perInvocation =
    (input.assumedInputTokensPerInvocation * inputRate) / 1_000_000 +
    (input.assumedOutputTokensPerInvocation * outputRate) / 1_000_000;
  return {
    value: perInvocation * input.trialPlanAgentInvocations,
    quality: 'estimated',
    source: 'pricing-snapshot',
    coverageReason: 'advisory ceiling from assumed per-invocation token usage',
  };
}

export function aggregatePhaseTelemetry(
  phases: readonly AgentTelemetry[],
): ReturnType<typeof aggregateTelemetryPhases> {
  return aggregateTelemetryPhases(phases);
}

export function findPricingFileNearSuite(suitePath: string): string {
  return join(dirname(suitePath), 'pricing.yaml');
}
