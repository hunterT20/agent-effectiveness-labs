import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { ProcessInvocation, ProcessResult } from '@ael/core';

import { redactSecrets } from './redaction.js';

export const DEFAULT_MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export type TerminationReason = 'exited' | 'timeout' | 'aborted';

export interface BoundedStreamMetadata {
  /** Bytes of redacted output kept (and written to disk when a `logDir` is configured). */
  readonly bytesCaptured: number;
  /** True when the child produced more raw output than `maxCaptureBytes`. */
  readonly truncated: boolean;
  /** SHA-256 of the exact redacted bytes that were kept/written. */
  readonly sha256: string;
}

export interface SupervisedProcessResult extends ProcessResult {
  readonly stdout: BoundedStreamMetadata;
  readonly stderr: BoundedStreamMetadata;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly terminationReason: TerminationReason;
}

export interface ProcessSupervisorOptions {
  readonly maxCaptureBytes?: number;
  readonly logDir?: string;
  /** Delay between SIGTERM and SIGKILL when terminating a process group. */
  readonly gracefulTimeoutMs?: number;
  /** Literal secret values redacted from captured output (in addition to built-in patterns). */
  readonly redactLiterals?: readonly string[];
}

export interface ProcessRunOptions {
  /** Aborting terminates the process tree exactly like a timeout would. */
  readonly signal?: AbortSignal;
  /** Extra literal secrets for this run; merged with the supervisor-level list. */
  readonly redactLiterals?: readonly string[];
}

function hashBuffer(buffer: Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex');
}

interface TerminationState {
  reason: TerminationReason;
  closed: boolean;
  killTimer: NodeJS.Timeout | undefined;
}

interface BoundedCapture {
  readonly chunks: Buffer[];
  captured: number;
  received: number;
}

function captureBounded(capture: BoundedCapture, maxBytes: number, chunk: Buffer): void {
  capture.received += chunk.length;
  if (capture.captured >= maxBytes) {
    return;
  }
  const remaining = maxBytes - capture.captured;
  const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
  capture.chunks.push(slice);
  capture.captured += slice.length;
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      shell: false,
      stdio: 'ignore',
    }).on('error', () => undefined);
    return;
  }
  try {
    // Negative pid targets the whole process group (child was spawned detached => group leader).
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process already gone.
    }
  }
}

export class ProcessSupervisor {
  private readonly maxCaptureBytes: number;
  private readonly logDir: string | undefined;
  private readonly gracefulTimeoutMs: number;
  private readonly redactLiterals: readonly string[];

  constructor(options: ProcessSupervisorOptions = {}) {
    this.maxCaptureBytes = options.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
    this.logDir = options.logDir;
    this.gracefulTimeoutMs = options.gracefulTimeoutMs ?? 1_000;
    this.redactLiterals = options.redactLiterals ?? [];
  }

  async run(
    invocation: ProcessInvocation,
    runOptions: ProcessRunOptions = {},
  ): Promise<SupervisedProcessResult> {
    const stdoutCapture: BoundedCapture = { chunks: [], captured: 0, received: 0 };
    const stderrCapture: BoundedCapture = { chunks: [], captured: 0, received: 0 };
    const literals = [...this.redactLiterals, ...(runOptions.redactLiterals ?? [])];

    const startedAt = performance.now();
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: invocation.cwd,
      env: { ...invocation.env },
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const state: TerminationState = { reason: 'exited', closed: false, killTimer: undefined };

    const terminate = (reason: TerminationReason): void => {
      if (state.closed || state.reason !== 'exited') {
        return;
      }
      state.reason = reason;
      killProcessTree(child, 'SIGTERM');
      state.killTimer = setTimeout(() => {
        if (!state.closed) {
          killProcessTree(child, 'SIGKILL');
        }
      }, this.gracefulTimeoutMs);
    };

    const timeoutHandle = setTimeout(() => {
      terminate('timeout');
    }, invocation.timeoutMs);

    const abortSignal = runOptions.signal;
    const onAbort = (): void => {
      terminate('aborted');
    };
    if (abortSignal !== undefined) {
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.stdout.on('data', (chunk: Buffer) => {
      captureBounded(stdoutCapture, this.maxCaptureBytes, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      captureBounded(stderrCapture, this.maxCaptureBytes, chunk);
    });

    const exit = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.on('error', () => {
          state.closed = true;
          resolve({ exitCode: 1, signal: null });
        });
        child.on('close', (exitCode, signal) => {
          state.closed = true;
          resolve({ exitCode, signal });
        });
      },
    );

    clearTimeout(timeoutHandle);
    if (state.killTimer !== undefined) {
      clearTimeout(state.killTimer);
    }
    abortSignal?.removeEventListener('abort', onAbort);
    const durationMs = performance.now() - startedAt;

    // Redact BEFORE anything is persisted; hash the exact bytes that are written.
    const stdoutRedacted = Buffer.from(
      redactSecrets(Buffer.concat(stdoutCapture.chunks).toString('utf8'), { literals }),
      'utf8',
    );
    const stderrRedacted = Buffer.from(
      redactSecrets(Buffer.concat(stderrCapture.chunks).toString('utf8'), { literals }),
      'utf8',
    );
    const stdoutMeta: BoundedStreamMetadata = {
      bytesCaptured: stdoutRedacted.length,
      truncated: stdoutCapture.received > stdoutCapture.captured,
      sha256: hashBuffer(stdoutRedacted),
    };
    const stderrMeta: BoundedStreamMetadata = {
      bytesCaptured: stderrRedacted.length,
      truncated: stderrCapture.received > stderrCapture.captured,
      sha256: hashBuffer(stderrRedacted),
    };

    const stdoutPath = join(this.logDir ?? invocation.cwd, 'stdout.log');
    const stderrPath = join(this.logDir ?? invocation.cwd, 'stderr.log');
    if (this.logDir !== undefined) {
      await mkdir(dirname(stdoutPath), { recursive: true });
      await writeFile(stdoutPath, stdoutRedacted);
      await writeFile(stderrPath, stderrRedacted);
    }

    const terminatedByUs = state.reason !== 'exited';
    return {
      exitCode: terminatedByUs ? null : exit.exitCode,
      signal: terminatedByUs ? (exit.signal ?? 'SIGTERM') : exit.signal,
      durationMs,
      stdout: stdoutMeta,
      stderr: stderrMeta,
      stdoutPath,
      stderrPath,
      terminationReason: state.reason,
    };
  }
}
