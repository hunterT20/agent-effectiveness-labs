import type { AgentTelemetry, MetricValue } from '@ael/core';

import {
  extractSessionChatId,
  parseStreamJsonLinesDetailed,
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

/** A line carries at most one usage block; `usage` wins over `message.usage` (never both). */
function usageOf(line: StreamJsonLine): StreamJsonUsage | undefined {
  return line.usage ?? line.message?.usage;
}

type UsageNumericField =
  | 'input_tokens'
  | 'output_tokens'
  | 'cache_read_input_tokens'
  | 'reasoning_tokens'
  | 'subagent_tokens';

function sumField(usages: readonly StreamJsonUsage[], field: UsageNumericField): number | null {
  let total = 0;
  let seen = false;
  for (const usage of usages) {
    const value = usage[field];
    if (typeof value === 'number' && Number.isFinite(value)) {
      total += value;
      seen = true;
    }
  }
  return seen ? total : null;
}

/**
 * Selects the authoritative usage blocks. cursor-agent repeats cumulative usage on the final
 * `result` event, so when any `result` event carries usage we use those and ignore per-turn
 * `assistant` usage. Otherwise we fall back to summing `assistant` usage blocks.
 */
function selectUsage(lines: readonly StreamJsonLine[]): {
  readonly usages: readonly StreamJsonUsage[];
  readonly basis: 'result' | 'assistant' | 'none';
} {
  const resultUsages: StreamJsonUsage[] = [];
  const assistantUsages: StreamJsonUsage[] = [];
  for (const line of lines) {
    const usage = usageOf(line);
    if (usage === undefined) {
      continue;
    }
    if (line.type === 'result') {
      resultUsages.push(usage);
    } else if (line.type === 'assistant') {
      assistantUsages.push(usage);
    }
  }
  if (resultUsages.length > 0) {
    return { usages: resultUsages, basis: 'result' };
  }
  if (assistantUsages.length > 0) {
    return { usages: assistantUsages, basis: 'assistant' };
  }
  return { usages: [], basis: 'none' };
}

function usageMetric(
  selected: ReturnType<typeof selectUsage>,
  field: UsageNumericField,
): MetricValue<number> {
  const total = sumField(selected.usages, field);
  if (total === null) {
    return unavailableMetric(`no ${field} in stream-json ${selected.basis} events`);
  }
  return exactMetric(total, selected.basis === 'assistant' ? 'summed assistant usage' : null);
}

/**
 * Counts tool invocations, not tool events. cursor-agent emits `tool_call` twice per call
 * (`subtype: started` and `subtype: completed`) sharing a `call_id`; we count distinct ids. Lines
 * without `call_id` count only when they are `started` or have no subtype at all.
 */
function countToolCalls(lines: readonly StreamJsonLine[]): MetricValue<number> {
  const callIds = new Set<string>();
  let anonymous = 0;
  let seen = false;
  for (const line of lines) {
    if (line.type === 'tool_call' || line.type === 'tool_use') {
      seen = true;
      if (line.call_id !== undefined && line.call_id.length > 0) {
        callIds.add(line.call_id);
      } else if (line.subtype === undefined || line.subtype === 'started') {
        anonymous += 1;
      }
      continue;
    }
    if (Array.isArray(line.tool_calls)) {
      seen = true;
      anonymous += line.tool_calls.length;
    }
  }
  if (!seen) {
    return unavailableMetric('no tool call events in stream-json');
  }
  return exactMetric(callIds.size + anonymous);
}

export interface CursorTelemetryExtraction {
  readonly telemetry: AgentTelemetry;
  readonly sessionChatId: string | null;
  /** Lines rejected by the stream-json schema (kept for evidence-quality reporting). */
  readonly rejectedLines: number;
}

export function extractCursorTelemetry(stdoutContent: string): CursorTelemetryExtraction {
  const { lines, rejectedLines } = parseStreamJsonLinesDetailed(stdoutContent);
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
      rejectedLines,
    };
  }

  const selected = selectUsage(lines);
  return {
    telemetry: {
      inputTokens: usageMetric(selected, 'input_tokens'),
      outputTokens: usageMetric(selected, 'output_tokens'),
      cachedInputTokens: usageMetric(selected, 'cache_read_input_tokens'),
      reasoningTokens: usageMetric(selected, 'reasoning_tokens'),
      subagentTokens: usageMetric(selected, 'subagent_tokens'),
      toolCalls: countToolCalls(lines),
    },
    sessionChatId: extractSessionChatId(lines),
    rejectedLines,
  };
}
