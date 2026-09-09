import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type {
  IsolationCapabilities,
  IsolationDoctorInput,
  IsolationDoctorResult,
  IsolationPrepareInput,
  IsolationProvider,
  IsolationSession,
  ProcessInvocation,
  ProcessResult,
} from '@ael/core';

import { redactSecrets } from '../process/redaction.js';

export const CONTAINER_DEFAULT_IMAGE = 'node:24-alpine';
export const CONTAINER_DEFAULT_MEMORY_LIMIT = '2g';
export const CONTAINER_DEFAULT_PIDS_LIMIT = 256;
export const CONTAINER_HOME = '/tmp/ael-home';
export const CONTAINER_WORKSPACE = '/workspace';

export interface ContainerIsolationOptions {
  /**
   * Host directory mounted at `/workspace` for the doctor probe. Trials always use the
   * `workspaceRoot` passed to `prepare()`. When omitted, doctor probes a fresh mkdtemp directory.
   */
  readonly workspaceRoot?: string;
  readonly denyNetwork?: boolean;
  readonly memoryLimit?: string;
  readonly pidsLimit?: number;
  readonly graderRoot?: string;
  readonly artifactRoot?: string;
  /** Relative (to the workspace) overlay paths mounted read-only on top of the workspace. */
  readonly armOverlayPaths?: readonly string[];
  readonly image?: string;
}

interface ContainerSession extends IsolationSession {
  readonly containerName: string;
  readonly workspaceRoot: string;
  readonly logDir?: string;
}

/** A single host→container bind mount as actually passed to `docker run`. */
export interface ContainerMount {
  readonly hostPath: string;
  readonly containerPath: string;
  readonly mode: 'rw' | 'ro';
}

function probeScriptPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'dockerProbe.mjs');
}

export async function isDockerAvailable(): Promise<boolean> {
  return new Promise((resolveAvailable) => {
    const child = spawn('docker', ['info'], { shell: false, stdio: 'ignore' });
    child.on('close', (code) => {
      resolveAvailable(code === 0);
    });
    child.on('error', () => {
      resolveAvailable(false);
    });
  });
}

interface DockerRunResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

interface DockerRunOptions {
  readonly timeoutMs?: number;
  readonly abortSignal?: AbortSignal;
}

async function runDocker(
  args: readonly string[],
  options: DockerRunOptions | number = 120_000,
): Promise<DockerRunResult> {
  const timeoutMs = typeof options === 'number' ? options : (options.timeoutMs ?? 120_000);
  const abortSignal = typeof options === 'number' ? undefined : options.abortSignal;
  return new Promise((resolveRun) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let aborted = false;
    const child = spawn('docker', [...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      child.kill('SIGKILL');
    };
    if (abortSignal !== undefined) {
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }
    }
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      resolveRun({
        exitCode: timedOut || aborted ? null : code,
        signal: timedOut || aborted ? 'SIGKILL' : signal,
        timedOut: timedOut || aborted,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
    child.on('error', () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      resolveRun({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: 'docker spawn failed',
      });
    });
  });
}

function isPathWithin(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * A host path counts as "mounted" when it lies inside any bind-mount source or when a bind-mount
 * source lies inside it (mounting a child directory still exposes part of the protected tree).
 */
export function isPathMounted(path: string, mounts: readonly ContainerMount[]): boolean {
  return mounts.some(
    (mount) => isPathWithin(path, mount.hostPath) || isPathWithin(mount.hostPath, path),
  );
}

export function buildContainerMounts(
  workspaceRoot: string,
  options: ContainerIsolationOptions,
): ContainerMount[] {
  const workspaceAbs = resolve(workspaceRoot);
  const mounts: ContainerMount[] = [
    { hostPath: workspaceAbs, containerPath: CONTAINER_WORKSPACE, mode: 'rw' },
  ];
  for (const overlayPath of options.armOverlayPaths ?? []) {
    const overlayAbs = resolve(workspaceAbs, overlayPath);
    if (!isPathWithin(overlayAbs, workspaceAbs)) {
      throw new Error(`arm overlay path escapes workspace: ${overlayPath}`);
    }
    mounts.push({
      hostPath: overlayAbs,
      containerPath: `${CONTAINER_WORKSPACE}/${relative(workspaceAbs, overlayAbs)}`,
      mode: 'ro',
    });
  }
  return mounts;
}

/** Hardened `docker run` prefix shared by trials and the doctor probe. */
export function buildHardenedRunArgs(
  containerName: string,
  options: ContainerIsolationOptions,
  mounts: readonly ContainerMount[],
): string[] {
  const args: string[] = [
    'run',
    '--rm',
    '--name',
    containerName,
    '--user',
    '1000:1000',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,mode=1777',
    '--tmpfs',
    `${CONTAINER_HOME}:rw,uid=1000,gid=1000,mode=0700`,
    '--pids-limit',
    String(options.pidsLimit ?? CONTAINER_DEFAULT_PIDS_LIMIT),
    '--memory',
    options.memoryLimit ?? CONTAINER_DEFAULT_MEMORY_LIMIT,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
  ];
  if (options.denyNetwork === true) {
    args.push('--network', 'none');
  }
  for (const mount of mounts) {
    args.push('-v', `${mount.hostPath}:${mount.containerPath}:${mount.mode}`);
  }
  return args;
}

const HOST_ONLY_ENV_KEYS = new Set([
  'HOME',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'CURSOR_CONFIG_DIR',
]);

function buildContainerEnv(invocationEnv: Readonly<Record<string, string>>): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(invocationEnv)) {
    if (HOST_ONLY_ENV_KEYS.has(key)) {
      continue;
    }
    args.push('-e', `${key}=${value}`);
  }
  args.push('-e', `HOME=${CONTAINER_HOME}`);
  args.push('-e', `XDG_CONFIG_HOME=${CONTAINER_HOME}/.config`);
  args.push('-e', `XDG_CACHE_HOME=${CONTAINER_HOME}/.cache`);
  args.push('-e', `XDG_DATA_HOME=${CONTAINER_HOME}/.local/share`);
  args.push('-e', `XDG_STATE_HOME=${CONTAINER_HOME}/.local/state`);
  args.push('-e', `CURSOR_CONFIG_DIR=${CONTAINER_HOME}/.cursor`);
  args.push('-e', 'TMPDIR=/tmp');
  return args;
}

function buildDockerRunArgs(
  session: ContainerSession,
  options: ContainerIsolationOptions,
  invocation: ProcessInvocation,
): string[] {
  const workspaceRoot = resolve(session.workspaceRoot);
  const mounts = buildContainerMounts(workspaceRoot, options);
  const args = buildHardenedRunArgs(session.containerName, options, mounts);
  const relCwd = isPathWithin(invocation.cwd, workspaceRoot)
    ? relative(workspaceRoot, resolve(invocation.cwd))
    : '';
  args.push('-w', relCwd.length > 0 ? `${CONTAINER_WORKSPACE}/${relCwd}` : CONTAINER_WORKSPACE);
  args.push(...buildContainerEnv(invocation.env));
  args.push(options.image ?? CONTAINER_DEFAULT_IMAGE);
  return args;
}

const ProbeOutputSchema = z
  .object({
    homeEnv: z.string(),
    homeIsTmpfs: z.boolean(),
    homeWritable: z.boolean(),
    writeSibling: z.boolean(),
    writeRootFs: z.boolean(),
    networkAccess: z.boolean(),
    bindMounts: z.array(z.string()),
  })
  .strict();

type ProbeOutput = z.infer<typeof ProbeOutputSchema>;

function parseProbeOutput(stdout: string): ProbeOutput | null {
  const lastLine = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  if (lastLine === undefined) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(lastLine);
  } catch {
    return null;
  }
  const parsed = ProbeOutputSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export class ContainerIsolationProvider implements IsolationProvider {
  constructor(private readonly options: ContainerIsolationOptions) {}

  async doctor(input: IsolationDoctorInput): Promise<IsolationDoctorResult> {
    const messages: string[] = [];
    let probe: ProbeOutput | null = null;
    let probeRan = false;

    if (await isDockerAvailable()) {
      const scratch =
        this.options.workspaceRoot === undefined
          ? await mkdtemp(join(tmpdir(), 'ael-container-doctor-'))
          : null;
      const probeWorkspace = scratch ?? resolve(this.options.workspaceRoot ?? '');
      try {
        const mounts = buildContainerMounts(probeWorkspace, this.options);
        const probeArgs = buildHardenedRunArgs(
          `ael-doctor-${String(process.pid)}-${String(Date.now())}`,
          this.options,
          [...mounts, { hostPath: probeScriptPath(), containerPath: '/probe.mjs', mode: 'ro' }],
        );
        probeArgs.push('-w', CONTAINER_WORKSPACE);
        probeArgs.push(...buildContainerEnv({}));
        probeArgs.push(this.options.image ?? CONTAINER_DEFAULT_IMAGE, 'node', '/probe.mjs');

        const run = await runDocker(probeArgs, 60_000);
        if (run.exitCode === 0) {
          probe = parseProbeOutput(run.stdout);
          probeRan = probe !== null;
          if (probe === null) {
            messages.push('container probe returned invalid JSON');
          }
        } else {
          messages.push(
            `container probe failed (exit ${String(run.exitCode)}): ${run.stderr.trim().slice(0, 500)}`,
          );
        }
      } finally {
        if (scratch !== null) {
          await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    } else {
      messages.push('docker daemon unavailable');
    }

    const expectedMountPoints = new Set([
      CONTAINER_WORKSPACE,
      '/probe.mjs',
      // Docker always bind-mounts these three files from the daemon host.
      '/etc/resolv.conf',
      '/etc/hostname',
      '/etc/hosts',
      ...buildContainerMounts(this.options.workspaceRoot ?? tmpdir(), this.options).map(
        (mount) => mount.containerPath,
      ),
    ]);
    const unexpectedMounts =
      probe?.bindMounts.filter((mountPoint) => !expectedMountPoints.has(mountPoint)) ?? [];
    if (unexpectedMounts.length > 0) {
      messages.push(`container exposes unexpected host mounts: ${unexpectedMounts.join(', ')}`);
    }
    if (probe !== null && probe.homeEnv !== CONTAINER_HOME) {
      messages.push(`container HOME is ${probe.homeEnv}, expected ${CONTAINER_HOME}`);
    }
    if (probe !== null && !probe.homeIsTmpfs) {
      messages.push('container HOME is not backed by tmpfs');
    }

    const filesystemEnforced =
      probeRan &&
      probe !== null &&
      probe.homeEnv === CONTAINER_HOME &&
      probe.homeIsTmpfs &&
      probe.homeWritable &&
      !probe.writeSibling &&
      !probe.writeRootFs &&
      unexpectedMounts.length === 0;
    const networkPolicyEnforced =
      probeRan && probe !== null && this.options.denyNetwork === true && !probe.networkAccess;

    const trialMounts = buildContainerMounts(this.options.workspaceRoot ?? tmpdir(), this.options);
    const graderNotMounted =
      this.options.graderRoot === undefined || !isPathMounted(this.options.graderRoot, trialMounts);
    const artifactNotMounted =
      this.options.artifactRoot === undefined ||
      !isPathMounted(this.options.artifactRoot, trialMounts);

    const observedCapabilities: IsolationCapabilities = {
      level: 'container',
      filesystemEnforced,
      networkPolicyEnforced,
      processTreeEnforced: probeRan,
      hiddenGraderProtected: probeRan && graderNotMounted,
      externalArtifactsProtected: probeRan && artifactNotMounted,
    };

    const requested = input.requestedCapabilities;
    let supported = true;
    if (requested.filesystemEnforced === true && !filesystemEnforced) {
      supported = false;
      messages.push('filesystem enforcement not observed');
    }
    if (requested.networkPolicyEnforced === true && !networkPolicyEnforced) {
      supported = false;
      messages.push('network policy enforcement not observed');
    }
    if (requested.processTreeEnforced === true && !observedCapabilities.processTreeEnforced) {
      supported = false;
      messages.push('process tree enforcement not observed (probe did not run)');
    }
    if (requested.hiddenGraderProtected === true && !observedCapabilities.hiddenGraderProtected) {
      supported = false;
      messages.push('hidden grader protection not observed');
    }
    if (
      requested.externalArtifactsProtected === true &&
      !observedCapabilities.externalArtifactsProtected
    ) {
      supported = false;
      messages.push('external artifact protection not observed');
    }

    return { supported, observedCapabilities, messages };
  }

  prepare(input: IsolationPrepareInput): Promise<IsolationSession> {
    const session: ContainerSession = {
      id: `${input.trialId}-container`,
      containerName: `ael-${input.trialId.replace(/[^a-zA-Z0-9_-]/g, '-')}-${String(process.pid)}`,
      workspaceRoot: input.workspaceRoot,
      ...(input.logDir !== undefined ? { logDir: input.logDir } : {}),
    };
    return Promise.resolve(session);
  }

  async run(session: IsolationSession, invocation: ProcessInvocation): Promise<ProcessResult> {
    const containerSession = toContainerSession(session);
    const startedAt = performance.now();
    const dockerArgs = buildDockerRunArgs(containerSession, this.options, invocation);
    dockerArgs.push(invocation.command, ...invocation.args);

    const result = await runDocker(dockerArgs, {
      timeoutMs: invocation.timeoutMs,
      ...(invocation.abortSignal !== undefined ? { abortSignal: invocation.abortSignal } : {}),
    });
    if (result.timedOut) {
      // Killing the `docker run` client does not stop the container; kill it by name.
      await runDocker(['kill', containerSession.containerName], 15_000);
      await runDocker(['rm', '-f', containerSession.containerName], 15_000);
    }
    const durationMs = performance.now() - startedAt;

    let stdoutPath: string | undefined;
    let stderrPath: string | undefined;
    if (containerSession.logDir !== undefined) {
      await mkdir(containerSession.logDir, { recursive: true });
      stdoutPath = join(containerSession.logDir, 'stdout.log');
      stderrPath = join(containerSession.logDir, 'stderr.log');
      await writeFile(stdoutPath, redactSecrets(result.stdout), 'utf8');
      await writeFile(stderrPath, redactSecrets(result.stderr), 'utf8');
    }

    return {
      exitCode: result.timedOut ? null : result.exitCode,
      signal: result.timedOut ? 'SIGKILL' : result.signal,
      durationMs,
      ...(stdoutPath !== undefined ? { stdoutPath } : {}),
      ...(stderrPath !== undefined ? { stderrPath } : {}),
    };
  }

  async dispose(session: IsolationSession): Promise<void> {
    const containerSession = toContainerSession(session);
    // Best-effort cleanup of a container that may have survived a crash (`--rm` handles the
    // normal path).
    await runDocker(['rm', '-f', containerSession.containerName], 15_000);
  }
}

function toContainerSession(session: IsolationSession): ContainerSession {
  if (
    'containerName' in session &&
    typeof session.containerName === 'string' &&
    'workspaceRoot' in session &&
    typeof session.workspaceRoot === 'string'
  ) {
    const logDir =
      'logDir' in session && typeof session.logDir === 'string' ? session.logDir : undefined;
    return {
      id: session.id,
      containerName: session.containerName,
      workspaceRoot: session.workspaceRoot,
      ...(logDir !== undefined ? { logDir } : {}),
    };
  }
  throw new Error(`session ${session.id} was not created by ContainerIsolationProvider`);
}
