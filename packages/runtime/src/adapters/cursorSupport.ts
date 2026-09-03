import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface CursorVersionInfo {
  readonly raw: string;
  readonly datePrefix: string;
  readonly supported: boolean;
}

export const TESTED_CURSOR_VERSION_RANGES = ['2026.07.', '2026.08.', '2026.09.'] as const;

export function parseCursorAgentVersion(raw: string): CursorVersionInfo {
  const trimmed = raw.trim();
  const datePrefix = trimmed.slice(0, 8);
  const supported = TESTED_CURSOR_VERSION_RANGES.some((prefix) => trimmed.startsWith(prefix));
  return { raw: trimmed, datePrefix, supported };
}

export async function readCursorAgentVersion(
  command = 'cursor-agent',
): Promise<CursorVersionInfo | null> {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => {
      resolve(null);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      resolve(parseCursorAgentVersion(Buffer.concat(chunks).toString('utf8')));
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

export interface CursorSandboxProbeResult {
  readonly readHomeBlocked: boolean;
  readonly writeOutsideWorkspaceBlocked: boolean;
  readonly networkBlocked: boolean;
  readonly messages: readonly string[];
}

export async function probeCursorSandbox(input: {
  readonly command: string;
  readonly workspaceRoot: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}): Promise<CursorSandboxProbeResult> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const probePrompt =
    'AEL_SANDBOX_PROBE: attempt read $HOME and write /tmp/ael-probe.txt; report JSON only';
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--trust',
    '--sandbox',
    'enabled',
    '--workspace',
    input.workspaceRoot,
  ];
  if (input.model !== undefined) {
    args.push('--model', input.model);
  }
  args.push(probePrompt);

  return new Promise((resolve) => {
    const child = spawn(input.command, args, {
      cwd: input.workspaceRoot,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...buildIsolatedHomeEnv(join(input.workspaceRoot, '.ael', 'probe-home')),
      },
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({
        readHomeBlocked: false,
        writeOutsideWorkspaceBlocked: false,
        networkBlocked: false,
        messages: ['cursor sandbox probe spawn failed'],
      });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const messages: string[] = [];
      let readHomeBlocked = stdout.includes('home_read_blocked') || stderr.includes('sandbox');
      let writeOutsideWorkspaceBlocked =
        stdout.includes('outside_write_blocked') || stderr.includes('sandbox');
      let networkBlocked = stdout.includes('network_blocked');
      if (stdout.length === 0 && stderr.length === 0) {
        messages.push('sandbox probe produced no output; capabilities unknown');
        readHomeBlocked = false;
        writeOutsideWorkspaceBlocked = false;
        networkBlocked = false;
      } else {
        messages.push('sandbox probe completed; capabilities inferred from observed output');
      }
      resolve({ readHomeBlocked, writeOutsideWorkspaceBlocked, networkBlocked, messages });
    });
  });
}
