/**
 * Environment variables passed to agent processes by default. Everything else in the parent
 * environment (cloud credentials, SSH agent sockets, IDE tokens, `NODE_OPTIONS`, …) is dropped
 * unless explicitly allowlisted or matched by a passthrough prefix.
 */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  // POSIX basics
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'SHELL',
  'USER',
  'LOGNAME',
  // Windows basics
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
];

export interface BuildAgentEnvironmentOptions {
  /** Source environment. Defaults to `process.env`. */
  readonly base?: NodeJS.ProcessEnv;
  /** Exact keys to keep from `base`. Defaults to {@link DEFAULT_ENV_ALLOWLIST}. */
  readonly allowlist?: readonly string[];
  /** Keys from `base` starting with any of these prefixes are kept (e.g. `['AEL_']`). */
  readonly passthroughPrefixes?: readonly string[];
  /** Additional variables. Always included and win over `base`. */
  readonly extra?: Record<string, string>;
  /** Keys whose values (from `base` or `extra`) must be redacted from persisted output. */
  readonly secretKeys?: readonly string[];
}

export interface AgentEnvironment {
  /** Final environment with keys in deterministic (code-unit sorted) order. */
  readonly env: Record<string, string>;
  /** Sorted, de-duplicated values that must be redacted from logs. */
  readonly secretValues: readonly string[];
  /** Sorted keys present in `base` that were not forwarded. */
  readonly droppedKeys: readonly string[];
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Windows environment keys are case-insensitive (`Path` vs `PATH`); POSIX keys are exact. */
function normalizeKey(key: string): string {
  return process.platform === 'win32' ? key.toUpperCase() : key;
}

export function buildAgentEnvironment(
  options: BuildAgentEnvironmentOptions = {},
): AgentEnvironment {
  const base = options.base ?? process.env;
  const allowlist = new Set((options.allowlist ?? DEFAULT_ENV_ALLOWLIST).map(normalizeKey));
  const prefixes = (options.passthroughPrefixes ?? []).map(normalizeKey);
  const extra = options.extra ?? {};
  const secretKeys = new Set((options.secretKeys ?? []).map(normalizeKey));

  const kept = new Map<string, string>();
  const dropped: string[] = [];
  const secretValues = new Set<string>();

  for (const key of Object.keys(base).sort(compareCodeUnits)) {
    const value = base[key];
    if (value === undefined) {
      continue;
    }
    const normalized = normalizeKey(key);
    if (secretKeys.has(normalized) && value.length > 0) {
      secretValues.add(value);
    }
    const allowed = allowlist.has(normalized) || prefixes.some((p) => normalized.startsWith(p));
    if (allowed) {
      kept.set(key, value);
    } else {
      dropped.push(key);
    }
  }

  for (const key of Object.keys(extra).sort(compareCodeUnits)) {
    const value = extra[key];
    if (value === undefined) {
      continue;
    }
    kept.set(key, value);
    if (secretKeys.has(normalizeKey(key)) && value.length > 0) {
      secretValues.add(value);
    }
  }

  const env: Record<string, string> = {};
  for (const key of [...kept.keys()].sort(compareCodeUnits)) {
    const value = kept.get(key);
    if (value !== undefined) {
      env[key] = value;
    }
  }

  const droppedKeys = dropped.filter((key) => !Object.hasOwn(extra, key)).sort(compareCodeUnits);

  return {
    env,
    secretValues: [...secretValues].sort(compareCodeUnits),
    droppedKeys,
  };
}
