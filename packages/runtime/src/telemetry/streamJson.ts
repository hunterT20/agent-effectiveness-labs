import { z } from 'zod';

/**
 * Token usage block as emitted by cursor-agent `--output-format stream-json`. Unknown keys are
 * tolerated (passthrough) because the vendor format is not versioned; unknown *types* are rejected.
 */
export const StreamJsonUsageSchema = z
  .object({
    input_tokens: z.number().finite().nonnegative().optional(),
    output_tokens: z.number().finite().nonnegative().optional(),
    cache_read_input_tokens: z.number().finite().nonnegative().optional(),
    cache_creation_input_tokens: z.number().finite().nonnegative().optional(),
    reasoning_tokens: z.number().finite().nonnegative().optional(),
    subagent_tokens: z.number().finite().nonnegative().optional(),
  })
  .passthrough();

export type StreamJsonUsage = z.infer<typeof StreamJsonUsageSchema>;

export const StreamJsonLineSchema = z
  .object({
    type: z.string().optional(),
    subtype: z.string().optional(),
    session_id: z.string().optional(),
    chat_id: z.string().optional(),
    call_id: z.string().optional(),
    usage: StreamJsonUsageSchema.optional(),
    tool_calls: z.array(z.unknown()).optional(),
    message: z
      .object({
        usage: StreamJsonUsageSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type StreamJsonLine = z.infer<typeof StreamJsonLineSchema>;

export interface StreamJsonParseResult {
  readonly lines: readonly StreamJsonLine[];
  /** Lines that were not JSON objects or failed schema validation. */
  readonly rejectedLines: number;
}

export function parseStreamJsonLinesDetailed(content: string): StreamJsonParseResult {
  const lines: StreamJsonLine[] = [];
  let rejectedLines = 0;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      rejectedLines += 1;
      continue;
    }
    const parsed = StreamJsonLineSchema.safeParse(raw);
    if (!parsed.success) {
      rejectedLines += 1;
      continue;
    }
    lines.push(parsed.data);
  }
  return { lines, rejectedLines };
}

export function parseStreamJsonLines(content: string): StreamJsonLine[] {
  return [...parseStreamJsonLinesDetailed(content).lines];
}

export function extractSessionChatId(lines: readonly StreamJsonLine[]): string | null {
  for (const line of lines) {
    if (typeof line.chat_id === 'string' && line.chat_id.length > 0) {
      return line.chat_id;
    }
    if (typeof line.session_id === 'string' && line.session_id.length > 0) {
      return line.session_id;
    }
  }
  return null;
}
