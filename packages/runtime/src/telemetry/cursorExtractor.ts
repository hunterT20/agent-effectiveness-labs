import type { AgentTelemetry, MetricValue } from '@ael/core';

import {
  extractSessionChatId,
  parseStreamJsonLines,
  type StreamJsonLine,
  type StreamJsonUsage,
} from './streamJson.js';

const SOURCE = 'cursor-stream-json';

function exactMetric(value: number, coverageReason: string | null = null): MetricValue<number> {
  return { value, quality: 'exact', source: SOURCE, coverageReason };
}

function unavailableMetric(reason: string): MetricValue<number> {
  return { value: null, quality: 'unavailable', source: SOURCE, coverageReason: reason };
}

function sumUsageField(
  lines: readonly StreamJsonLine[],
  field: keyof StreamJsonUsage,
): MetricValue<number> {
  let total = 0;
  let seen = false;
  for (const line of lines) {
    const usages: Array<StreamJsonUsage | undefined> = [line.usage, line.message?.usage];
    for (const usage of usages) {
      if (usage === undefined) {
        continue;
      }
      const value = usage[field];
      if (typeof value === 'number' && Number.isFinite(value)) {
        total += value;
        seen = true;
      }
    }
  }
  if (!seen) {
    return unavailableMetric(`no ${field} in stream-json events`);
  }
  return exactMetric(total);
}

function countToolCalls(lines: readonly StreamJsonLine[]): MetricValue<number> {
  let total = 0;
  let seen = false;
  for (const line of lines) {
    if (line.type === 'tool_call' || line.type === 'tool_use') {
      total += 1;
      seen = true;
      continue;
    }
    if (Array.isArray(line.tool_calls)) {
      total += line.tool_calls.length;
      seen = true;
    }
  }
  if (!seen) {
    return unavailableMetric('no tool call events in stream-json');
  }
  return exactMetric(total);
}

export interface CursorTelemetryExtraction {
  readonly telemetry: AgentTelemetry;
  readonly sessionChatId: string | null;
}

export function extractCursorTelemetry(stdoutContent: string): CursorTelemetryExtraction {
  const lines = parseStreamJsonLines(stdoutContent);
  if (lines.length === 0) {
    const unavailable = unavailableMetric('empty or unparseable stream-json stdout');
    return {
      telemetry: {
        inputTokens: unavailable,
        outputTokens: unavailable,
        cachedInputTokens: unavailable,
        reasoningTokens: unavailable,
        subagentTokens: unavailable,
        toolCalls: unavailable,
      },
      sessionChatId: null,
    };
  }

  return {
    telemetry: {
      inputTokens: sumUsageField(lines, 'input_tokens'),
      outputTokens: sumUsageField(lines, 'output_tokens'),
      cachedInputTokens: sumUsageField(lines, 'cache_read_input_tokens'),
      reasoningTokens: sumUsageField(lines, 'reasoning_tokens'),
      subagentTokens: sumUsageField(lines, 'subagent_tokens'),
      toolCalls: countToolCalls(lines),
    },
    sessionChatId: extractSessionChatId(lines),
  };
}
