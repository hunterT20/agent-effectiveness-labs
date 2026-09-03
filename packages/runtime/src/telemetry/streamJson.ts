export interface StreamJsonLine {
  readonly type?: string;
  readonly subtype?: string;
  readonly session_id?: string;
  readonly chat_id?: string;
  readonly usage?: StreamJsonUsage;
  readonly tool_calls?: readonly unknown[];
  readonly message?: {
    readonly usage?: StreamJsonUsage;
  };
}

export interface StreamJsonUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly reasoning_tokens?: number;
  readonly subagent_tokens?: number;
}

export function parseStreamJsonLines(content: string): StreamJsonLine[] {
  const lines: StreamJsonLine[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as StreamJsonLine;
      lines.push(parsed);
    } catch {
      // skip malformed lines; extractor marks telemetry unavailable
    }
  }
  return lines;
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
