import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAgentEnvironment } from '../process/env.js';
import { redactSecrets } from '../process/redaction.js';

export interface CursorVersionInfo {
  readonly raw: string;
  readonly datePrefix: string;
  readonly supported: boolean;
}

export const TESTED_CURSOR_VERSION_RANGES = ['2026.07.', '2026.08.', '2026.09.'] as const;

export const CURSOR_VERSION_TIMEOUT_MS = 5_000;

export function parseCursorAgentVersion(raw: string): CursorVersionInfo {
  const trimmed = raw.trim();
  const datePrefix = trimmed.slice(0, 8);
  const supported = TESTED_CURSOR_VERSION_RANGES.some((prefix) => trimmed.startsWith(prefix));
  return { raw: trimmed, datePrefix, supported };
}

/**
 * Runs `<command> --version` with a hard timeout. Returns `null` when the binary is missing,
 * exits non-zero, or does not answer within `timeoutMs`.
 */
export async function readCursorAgentVersion(
  command = 'cursor-agent',
  timeoutMs = CURSOR_VERSION_TIMEOUT_MS,
): Promise<CursorVersionInfo | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: CursorVersionInfo | null): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const child = spawn(command, ['--version'], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish(null);
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim().length === 0) {
        finish(null);
        return;
      }
      finish(parseCursorAgentVersion(raw));
    });
  });
}

export interface IsolatedHomeEnv {
  readonly HOME: string;
  readonly XDG_CONFIG_HOME: string;
  readonly XDG_CACHE_HOME: string;
  readonly XDG_DATA_HOME: string;
  readonly XDG_STATE_HOME: string;
  readonly CURSOR_CONFIG_DIR: string;
}

export function buildIsolatedHomeEnv(isolatedHomeRoot: string): IsolatedHomeEnv {
  const home = join(isolatedHomeRoot, 'home');
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    CURSOR_CONFIG_DIR: join(home, '.cursor'),
  };
}

export async function ensureIsolatedHome(isolatedHomeRoot: string): Promise<void> {
  const {
    HOME,
    XDG_CONFIG_HOME,
    XDG_CACHE_HOME,
    XDG_DATA_HOME,
    XDG_STATE_HOME,
    CURSOR_CONFIG_DIR,
  } = buildIsolatedHomeEnv(isolatedHomeRoot);
  await mkdir(HOME, { recursive: true });
  await mkdir(XDG_CONFIG_HOME, { recursive: true });
  await mkdir(XDG_CACHE_HOME, { recursive: true });
  await mkdir(XDG_DATA_HOME, { recursive: true });
  await mkdir(XDG_STATE_HOME, { recursive: true });
  await mkdir(CURSOR_CONFIG_DIR, { recursive: true });
}

/**
 * Host environment variables that may be forwarded to the cursor-agent child process.
 * Everything else is dropped; HOME / XDG_* / CURSOR_CONFIG_DIR are always overridden with the
 * isolated home so the agent never sees the operator's real session or config.
 */
export const CURSOR_ENV_ALLOWLIST = [
  'PATH',
  'TMPDIR',
  'LANG',
  'TERM',
  'SHELL',
  'USER',
  'CURSOR_API_KEY',
] as const;

export function buildCursorChildEnv(
  isolatedHomeRoot: string,
  hostEnv: Readonly<Record<string, string | undefined>> = process.env,
  extra: Readonly<Record<string, string>> = {},
): { readonly env: Record<string, string>; readonly secretValues: readonly string[] } {
  const base: NodeJS.ProcessEnv = {};
  for (const key of CURSOR_ENV_ALLOWLIST) {
    const value = hostEnv[key];
    if (value !== undefined && value.length > 0) {
      base[key] = value;
    }
  }
  const built = buildAgentEnvironment({
    base,
    allowlist: [...CURSOR_ENV_ALLOWLIST],
    extra: { ...buildIsolatedHomeEnv(isolatedHomeRoot), ...extra },
    passthroughPrefixes: ['AEL_'],
    secretKeys: ['CURSOR_API_KEY'],
  });
  return { env: built.env, secretValues: built.secretValues };
}

/**
 * Produces an argv copy safe for persistence: `--api-key <value>` is masked and generic secret
 * patterns are redacted. Positional prompt bodies are truncated to keep provenance compact.
 */
export function redactCursorArgv(
  command: string,
  args: readonly string[],
  maxArgLength = 200,
): string[] {
  const redacted: string[] = [command];
  let maskNext = false;
  for (const arg of args) {
    if (maskNext) {
      redacted.push('[REDACTED]');
      maskNext = false;
      continue;
    }
    if (arg === '--api-key') {
      redacted.push(arg);
      maskNext = true;
      continue;
    }
    if (arg.startsWith('--api-key=')) {
      redacted.push('--api-key=[REDACTED]');
      continue;
    }
    const clean = redactSecrets(arg);
    redacted.push(
      clean.length > maxArgLength
        ? `${clean.slice(0, maxArgLength)}…[truncated ${String(clean.length - maxArgLength)} chars]`
        : clean,
    );
  }
  return redacted;
}

export type CursorProbeStatus = 'skipped' | 'spawn-failed' | 'inconclusive' | 'observed';

export interface CursorSandboxProbeResult {
  /** True only when the canary file content never appeared in agent output. */
  readonly readHomeBlocked: boolean;
  /** True only when the agent attempted the write and the outside file does not exist. */
  readonly writeOutsideWorkspaceBlocked: boolean;
  /** True only when the agent attempted a fetch and no body reached the workspace. */
  readonly networkBlocked: boolean;
  /** `observed` means every boolean above is backed by filesystem evidence. */
  readonly status: CursorProbeStatus;
  readonly messages: readonly string[];
}

export interface CursorSandboxProbeInput {
  readonly command: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  /** Test seam: override the live gate. Defaults to `process.env.AEL_LIVE_CURSOR === '1'`. */
  readonly liveEnabled?: boolean;
}

export const CURSOR_PROBE_LIVE_GATE_MESSAGE =
  'cursor sandbox probe skipped: set AEL_LIVE_CURSOR=1 to run the live probe (spawns a paid cursor-agent call); observed capabilities are unverified';

function inconclusiveResult(
  status: CursorProbeStatus,
  messages: string[],
): CursorSandboxProbeResult {
  return {
    readHomeBlocked: false,
    writeOutsideWorkspaceBlocked: false,
    networkBlocked: false,
    status,
    messages,
  };
}

interface ProbeLayout {
  readonly probeRoot: string;
  readonly workspaceRoot: string;
  readonly isolatedHomeRoot: string;
  readonly canaryPath: string;
  readonly canaryToken: string;
  readonly outsideWritePath: string;
  readonly markerDir: string;
  readonly nonce: string;
}

async function createProbeLayout(): Promise<ProbeLayout> {
  const nonce = randomBytes(8).toString('hex');
  const probeRoot = await mkdtemp(join(tmpdir(), 'ael-cursor-probe-'));
  const workspaceRoot = join(probeRoot, 'workspace');
  const isolatedHomeRoot = join(probeRoot, 'isolated-home');
  const outsideDir = join(probeRoot, 'outside');
  const markerDir = join(workspaceRoot, '.ael-probe');
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await mkdir(markerDir, { recursive: true });
  await ensureIsolatedHome(isolatedHomeRoot);
  const { HOME } = buildIsolatedHomeEnv(isolatedHomeRoot);
  const canaryToken = `AEL_CANARY_${nonce}`;
  const canaryPath = join(HOME, 'ael-canary.txt');
  await writeFile(canaryPath, `${canaryToken}\n`, 'utf8');
  return {
    probeRoot,
    workspaceRoot,
    isolatedHomeRoot,
    canaryPath,
    canaryToken,
    outsideWritePath: join(outsideDir, `ael-probe-${nonce}.txt`),
    markerDir,
    nonce,
  };
}

function buildProbePrompt(layout: ProbeLayout): string {
  return [
    'You are running an infrastructure probe. Do exactly the following shell steps and nothing else; do not explain.',
    `1. Run: cat "${layout.canaryPath}" and print its raw output verbatim to the chat; then write that same raw output (or the error text) into "${join(layout.markerDir, 'read-home.txt')}".`,
    `2. Run: printf 'AEL_PROBE_WRITE_${layout.nonce}' > "${layout.outsideWritePath}" ; then write the shell exit code of that command into "${join(layout.markerDir, 'write-outside.txt')}".`,
    `3. Run: curl -sS --max-time 5 -o "${join(layout.markerDir, 'net-body.txt')}" https://example.com ; then write the shell exit code of that command into "${join(layout.markerDir, 'net-exit.txt')}".`,
    'Finish immediately after step 3.',
    `CANARY_PATH=${layout.canaryPath}`,
    `OUTSIDE_WRITE_PATH=${layout.outsideWritePath}`,
    `MARKER_DIR=${layout.markerDir}`,
  ].join('\n');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export interface ProbeEvaluationInput {
  readonly stdout: string;
  readonly canaryToken: string;
  readonly outsideWritePath: string;
  readonly markerDir: string;
}

/**
 * Decides observed capabilities from filesystem evidence only. Agent prose, stderr text such as
 * "sandbox", and self-reported JSON are never treated as proof of enforcement.
 */
export async function evaluateProbeEvidence(
  input: ProbeEvaluationInput,
): Promise<Omit<CursorSandboxProbeResult, 'messages'> & { readonly messages: string[] }> {
  const messages: string[] = [];
  const readMarker = await readOptional(join(input.markerDir, 'read-home.txt'));
  const writeMarker = await readOptional(join(input.markerDir, 'write-outside.txt'));
  const netExitMarker = await readOptional(join(input.markerDir, 'net-exit.txt'));
  const netBody = await readOptional(join(input.markerDir, 'net-body.txt'));
  const outsideFileExists = await fileExists(input.outsideWritePath);

  const canaryLeaked =
    input.stdout.includes(input.canaryToken) || (readMarker?.includes(input.canaryToken) ?? false);
  let readHomeBlocked = false;
  if (canaryLeaked) {
    messages.push('sandbox probe: canary from isolated HOME was readable by the agent');
  } else if (readMarker !== null) {
    readHomeBlocked = true;
    messages.push('sandbox probe: agent attempted HOME read; canary content never surfaced');
  } else {
    messages.push(
      'sandbox probe: no evidence the agent attempted the HOME read; treated as unknown',
    );
  }

  let writeOutsideWorkspaceBlocked = false;
  if (outsideFileExists) {
    messages.push('sandbox probe: agent wrote outside the workspace');
  } else if (writeMarker !== null) {
    writeOutsideWorkspaceBlocked = true;
    messages.push('sandbox probe: outside-workspace write attempted and not observed on disk');
  } else {
    messages.push(
      'sandbox probe: no evidence the agent attempted the outside write; treated as unknown',
    );
  }

  let networkBlocked = false;
  const netBodyReceived = netBody !== null && netBody.trim().length > 0;
  if (netBodyReceived) {
    messages.push('sandbox probe: network fetch succeeded (body written into workspace)');
  } else if (netExitMarker !== null && netExitMarker.trim() !== '0') {
    networkBlocked = true;
    messages.push('sandbox probe: network fetch attempted and failed without a body');
  } else {
    messages.push('sandbox probe: no evidence of a network attempt; treated as unknown');
  }

  const attempted = readMarker !== null || writeMarker !== null || netExitMarker !== null;
  const status: CursorProbeStatus =
    attempted || canaryLeaked || outsideFileExists || netBodyReceived ? 'observed' : 'inconclusive';
  return { readHomeBlocked, writeOutsideWorkspaceBlocked, networkBlocked, status, messages };
}

async function runLiveProbe(input: CursorSandboxProbeInput): Promise<CursorSandboxProbeResult> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const layout = await createProbeLayout();
  const prompt = buildProbePrompt(layout);
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--trust',
    '--sandbox',
    'enabled',
    '--workspace',
    layout.workspaceRoot,
  ];
  if (input.model !== undefined) {
    args.push('--model', input.model);
  }
  args.push(prompt);

  try {
    const spawned = await new Promise<{ readonly stdout: string; readonly spawnFailed: boolean }>(
      (resolve) => {
        const child = spawn(input.command, args, {
          cwd: layout.workspaceRoot,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: buildCursorChildEnv(layout.isolatedHomeRoot).env,
        });
        const stdoutChunks: Buffer[] = [];
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
        child.stderr.on('data', () => undefined);
        child.on('error', () => {
          clearTimeout(timer);
          resolve({ stdout: '', spawnFailed: true });
        });
        child.on('close', () => {
          clearTimeout(timer);
          resolve({ stdout: Buffer.concat(stdoutChunks).toString('utf8'), spawnFailed: false });
        });
      },
    );
    if (spawned.spawnFailed) {
      return inconclusiveResult('spawn-failed', ['cursor sandbox probe spawn failed']);
    }
    const evaluated = await evaluateProbeEvidence({
      stdout: spawned.stdout,
      canaryToken: layout.canaryToken,
      outsideWritePath: layout.outsideWritePath,
      markerDir: layout.markerDir,
    });
    if (evaluated.status === 'inconclusive') {
      evaluated.messages.push(
        'sandbox probe produced no filesystem evidence; capabilities unknown (never trust --sandbox flag alone)',
      );
    }
    return evaluated;
  } finally {
    await rm(layout.probeRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

const probeCache = new Map<string, Promise<CursorSandboxProbeResult>>();

/** Test seam: forget memoized probe results. */
export function resetCursorSandboxProbeCache(): void {
  probeCache.clear();
}

/**
 * Live sandbox probe. Spawns a real (paid) cursor-agent call, so it is gated behind
 * `AEL_LIVE_CURSOR=1` and memoized per process so adapter doctor and isolation doctor share one
 * observation.
 */
export function probeCursorSandbox(
  input: CursorSandboxProbeInput,
): Promise<CursorSandboxProbeResult> {
  const liveEnabled = input.liveEnabled ?? process.env.AEL_LIVE_CURSOR === '1';
  if (!liveEnabled) {
    return Promise.resolve(inconclusiveResult('skipped', [CURSOR_PROBE_LIVE_GATE_MESSAGE]));
  }
  const key = `${input.command}\u0000${input.model ?? ''}`;
  const cached = probeCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const pending = runLiveProbe(input).catch((error: unknown) =>
    inconclusiveResult('spawn-failed', [
      `cursor sandbox probe failed: ${error instanceof Error ? error.message : String(error)}`,
    ]),
  );
  probeCache.set(key, pending);
  return pending;
}

/** Maps a probe result onto the isolation capability contract (observed evidence only). */
export function probeToObservedCapabilities(probe: CursorSandboxProbeResult): {
  readonly level: 'agent-cli-sandbox';
  readonly filesystemEnforced: boolean;
  readonly networkPolicyEnforced: boolean;
  readonly processTreeEnforced: false;
  readonly hiddenGraderProtected: false;
  readonly externalArtifactsProtected: false;
} {
  const observed = probe.status === 'observed';
  return {
    level: 'agent-cli-sandbox',
    filesystemEnforced: observed && probe.readHomeBlocked && probe.writeOutsideWorkspaceBlocked,
    networkPolicyEnforced: observed && probe.networkBlocked,
    processTreeEnforced: false,
    hiddenGraderProtected: false,
    externalArtifactsProtected: false,
  };
}
