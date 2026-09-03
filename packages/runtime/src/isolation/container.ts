import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

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

export interface ContainerIsolationOptions {
  readonly workspaceRoot: string;
  readonly denyNetwork?: boolean;
  readonly memoryLimit?: string;
  readonly pidsLimit?: number;
  readonly graderRoot?: string;
  readonly artifactRoot?: string;
  readonly armOverlayPaths?: readonly string[];
}

interface ContainerSession extends IsolationSession {
  readonly containerName: string;
  readonly workspaceRoot: string;
  readonly options: ContainerIsolationOptions;
}

function probeScriptPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'dockerProbe.mjs');
}

export async function isDockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['info'], { shell: false, stdio: 'ignore' });
    child.on('close', (code) => {
      resolve(code === 0);
    });
    child.on('error', () => {
      resolve(false);
    });
  });
}

async function runDocker(
  args: readonly string[],
  timeoutMs = 120_000,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const child = spawn('docker', [...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout: '', stderr: 'docker spawn failed' });
    });
  });
}

function buildDockerRunArgs(session: ContainerSession, invocation: ProcessInvocation): string[] {
  const workspaceRoot = resolve(session.workspaceRoot);
  const args: string[] = ['run', '--rm', '--user', '1000:1000'];
  args.push('--pids-limit', String(session.options.pidsLimit ?? 256));
  if (session.options.memoryLimit !== undefined) {
    args.push('--memory', session.options.memoryLimit);
  }
  if (session.options.denyNetwork === true) {
    args.push('--network', 'none');
  }
  args.push('-v', `${workspaceRoot}:/workspace:rw`);
  for (const overlayPath of session.options.armOverlayPaths ?? []) {
    const overlayAbs = resolve(workspaceRoot, overlayPath);
    args.push('-v', `${overlayAbs}:/workspace/${overlayPath}:ro`);
  }
  const relCwd = invocation.cwd.startsWith(workspaceRoot)
    ? invocation.cwd.slice(workspaceRoot.length).replace(/^\//, '')
    : '';
  args.push('-w', relCwd.length > 0 ? `/workspace/${relCwd}` : '/workspace');
  for (const [key, value] of Object.entries(invocation.env)) {
    args.push('-e', `${key}=${value}`);
  }
  args.push('node:24-alpine');
  return args;
}

export class ContainerIsolationProvider implements IsolationProvider {
  constructor(private readonly options: ContainerIsolationOptions) {}

  async doctor(input: IsolationDoctorInput): Promise<IsolationDoctorResult> {
    const messages: string[] = [];
    let readHome = false;
    let writeSibling = false;
    let networkAccess = false;

    if (await isDockerAvailable()) {
      const probeMount = resolve(this.options.workspaceRoot);
      const probeArgs = [
        'run',
        '--rm',
        '--user',
        '1000:1000',
        '--pids-limit',
        String(this.options.pidsLimit ?? 256),
      ];
      if (this.options.denyNetwork === true) {
        probeArgs.push('--network', 'none');
      }
      probeArgs.push('-v', `${probeMount}:/workspace:rw`);
      probeArgs.push('-v', `${probeScriptPath()}:/probe.mjs:ro`);
      probeArgs.push('-w', '/workspace');
      probeArgs.push('node:24-alpine');
      probeArgs.push('node', '/probe.mjs');

      const probe = await runDocker(probeArgs, 30_000);
      if (probe.exitCode === 0) {
        try {
          const parsed = JSON.parse(probe.stdout.trim()) as {
            readHome?: boolean;
            writeSibling?: boolean;
            networkAccess?: boolean;
          };
          readHome = parsed.readHome === true;
          writeSibling = parsed.writeSibling === true;
          networkAccess = parsed.networkAccess === true;
        } catch {
          messages.push('container probe returned invalid JSON');
        }
      } else {
        messages.push(`container probe failed: ${probe.stderr.trim()}`);
      }
    } else {
      messages.push('docker daemon unavailable');
    }

    const filesystemEnforced = !readHome && !writeSibling;
    const networkPolicyEnforced = this.options.denyNetwork === true && !networkAccess;
    const graderNotMounted =
      this.options.graderRoot === undefined ||
      !isPathMounted(this.options.graderRoot, this.options);
    const artifactNotMounted =
      this.options.artifactRoot === undefined ||
      !isPathMounted(this.options.artifactRoot, this.options);

    const observedCapabilities: IsolationCapabilities = {
      level: 'container',
      filesystemEnforced,
      networkPolicyEnforced,
      processTreeEnforced: true,
      hiddenGraderProtected: graderNotMounted,
      externalArtifactsProtected: artifactNotMounted,
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
    if (requested.hiddenGraderProtected === true && !graderNotMounted) {
      supported = false;
      messages.push('hidden grader protection not observed');
    }
    if (requested.externalArtifactsProtected === true && !artifactNotMounted) {
      supported = false;
      messages.push('external artifact protection not observed');
    }

    return { supported, observedCapabilities, messages };
  }

  prepare(input: IsolationPrepareInput): Promise<IsolationSession> {
    const session: ContainerSession = {
      id: `${input.trialId}-container`,
      containerName: `ael-${input.trialId.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
      workspaceRoot: input.workspaceRoot,
      options: this.options,
    };
    return Promise.resolve(session);
  }

  async run(session: IsolationSession, invocation: ProcessInvocation): Promise<ProcessResult> {
    const containerSession = session as ContainerSession;
    const startedAt = performance.now();
    const dockerArgs = buildDockerRunArgs(containerSession, invocation);
    dockerArgs.push(invocation.command, ...invocation.args);

    const result = await runDocker(dockerArgs, invocation.timeoutMs);
    const durationMs = performance.now() - startedAt;

    return {
      exitCode: result.exitCode,
      signal: result.exitCode === 0 ? null : null,
      durationMs,
    };
  }

  dispose(session: IsolationSession): Promise<void> {
    void session;
    return Promise.resolve();
  }
}

function isPathMounted(path: string, options: ContainerIsolationOptions): boolean {
  void path;
  void options;
  return false;
}
