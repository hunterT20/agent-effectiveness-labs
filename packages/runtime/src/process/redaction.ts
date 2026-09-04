import { StringDecoder } from 'node:string_decoder';

export const REDACTED_PLACEHOLDER = '[REDACTED]';

/**
 * Minimum length for a literal secret value to be redacted. Shorter literals are ignored to avoid
 * destroying unrelated output (e.g. a secret value of `"1"` would otherwise blank every digit).
 */
export const MIN_LITERAL_SECRET_LENGTH = 8;

/**
 * Maximum number of characters a streaming redactor buffers while waiting for a line terminator.
 * A single line longer than this is redacted and emitted eagerly; a secret straddling that exact
 * boundary could escape, which is accepted to keep memory bounded.
 */
export const MAX_PENDING_LINE_CHARS = 1024 * 1024;

interface SecretPattern {
  readonly pattern: RegExp;
  readonly replacement: string;
}

const KEY_NAMES =
  'api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization';

/**
 * Ordered secret patterns. Order matters: token-shaped values (`Bearer …`, `sk-…`) are redacted
 * before generic `key=value` patterns so that `Authorization: Bearer xyz` collapses to a single
 * `Authorization: [REDACTED]` rather than leaving the token behind.
 */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  // Bearer tokens (Authorization headers, curl output, SDK logs).
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, replacement: REDACTED_PLACEHOLDER },
  // OpenAI-style keys, including project keys (`sk-proj-…`).
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}/g, replacement: REDACTED_PLACEHOLDER },
  // GitHub personal/OAuth/app tokens.
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replacement: REDACTED_PLACEHOLDER },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: REDACTED_PLACEHOLDER },
  // AWS access key ids.
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: REDACTED_PLACEHOLDER },
  // CLI flags: `--api-key <value>` and `--api-key=<value>` (value must not itself be a flag).
  {
    pattern: new RegExp(`(--(?:${KEY_NAMES}))(=|\\s+)(?!-)(\\S+)`, 'gi'),
    replacement: `$1$2${REDACTED_PLACEHOLDER}`,
  },
  // Generic `key: value`, `key=value`, `"key": "value"` forms.
  {
    pattern: new RegExp(`((?:${KEY_NAMES})["']?\\s*[:=]\\s*["']?)(\\S+)`, 'gi'),
    replacement: `$1${REDACTED_PLACEHOLDER}`,
  },
];

export interface RedactSecretsOptions {
  /**
   * Exact secret values to remove wherever they appear. Values shorter than
   * {@link MIN_LITERAL_SECRET_LENGTH} are ignored.
   */
  readonly literals?: readonly string[];
}

function normalizeLiterals(literals: readonly string[] | undefined): readonly string[] {
  if (literals === undefined) {
    return [];
  }
  const unique = new Set<string>();
  for (const literal of literals) {
    if (literal.length >= MIN_LITERAL_SECRET_LENGTH) {
      unique.add(literal);
    }
  }
  // Longest first so a literal that contains another literal is removed as a whole.
  return [...unique].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

function redactWithLiterals(text: string, literals: readonly string[]): string {
  let redacted = text;
  for (const literal of literals) {
    if (redacted.includes(literal)) {
      redacted = redacted.split(literal).join(REDACTED_PLACEHOLDER);
    }
  }
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

/**
 * Redact secrets from `text`. Literal values are removed first (exact match), then the built-in
 * token patterns are applied.
 */
export function redactSecrets(text: string, options: RedactSecretsOptions = {}): string {
  return redactWithLiterals(text, normalizeLiterals(options.literals));
}

/**
 * Incremental, line-buffered redactor. Complete lines are redacted and returned from `push`; the
 * trailing partial line is held back until the next newline (or `flush`) so a secret that is split
 * across two chunks is still caught as a whole.
 */
export interface StreamingRedactor {
  push(chunk: string | Uint8Array): string;
  flush(): string;
}

export function createStreamingRedactor(options: RedactSecretsOptions = {}): StreamingRedactor {
  const literals = normalizeLiterals(options.literals);
  const decoder = new StringDecoder('utf8');
  let pending = '';

  return {
    push(chunk: string | Uint8Array): string {
      pending += typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk));
      const lastNewline = pending.lastIndexOf('\n');
      let ready: string;
      if (lastNewline === -1) {
        if (pending.length < MAX_PENDING_LINE_CHARS) {
          return '';
        }
        ready = pending;
        pending = '';
      } else {
        ready = pending.slice(0, lastNewline + 1);
        pending = pending.slice(lastNewline + 1);
      }
      return redactWithLiterals(ready, literals);
    },
    flush(): string {
      const tail = pending + decoder.end();
      pending = '';
      return tail.length === 0 ? '' : redactWithLiterals(tail, literals);
    },
  };
}
