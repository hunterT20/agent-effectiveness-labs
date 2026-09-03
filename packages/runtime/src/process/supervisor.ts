import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { ProcessInvocation, ProcessResult } from '@ael/core';

import { redactSecrets } from './redaction.js';

export const DEFAULT_MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export interface BoundedStreamMetadata {
  readonly bytesCaptured: number;
  readonly truncated: boolean;
  readonly sha256: string;
}

export interface SupervisedProcessResult extends ProcessResult {
  readonly stdout: BoundedStreamMetadata;
  readonly stderr: BoundedStreamMetadata;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

export interface ProcessSupervisorOptions {
  readonly maxCaptureBytes?: number;
  readonly logDir?: string;
  readonly gracefulTimeoutMs?: number;
}

function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function captureBounded(
  chunks: Buffer[],
  totalBytes: { value: number },
  maxBytes: number,
  chunk: Buffer,
): void {
  if (totalBytes.value >= maxBytes) {
    return;
  }
  const remaining = maxBytes - totalBytes.value;
  const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
  chunks.push(slice);
  totalBytes.value += slice.length;
}

async function terminateProcessTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false });
    await Promise.resolve();
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

export class ProcessSupervisor {
  private readonly maxCaptureBytes: number;
  private readonly logDir: string | undefined;
  private readonly gracefulTimeoutMs: number;

  constructor(options: ProcessSupervisorOptions = {}) {
    this.maxCaptureBytes = options.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
    this.logDir = options.logDir;
    this.gracefulTimeoutMs = options.gracefulTimeoutMs ?? 1_000;
  }

  async run(invocation: ProcessInvocation): Promise<SupervisedProcessResult> {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutBytes = { value: 0 };
    const stderrBytes = { value: 0 };
    let stdoutReceived = 0;
    let stderrReceived = 0;

    const startedAt = performance.now();
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: invocation.cwd,
      env: { ...invocation.env },
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeoutState = { timedOut: false };
    const timeoutHandle = setTimeout(() => {
      timeoutState.timedOut = true;
      void terminateProcessTree(child);
      setTimeout(() => {
        if (child.pid !== undefined && !child.killed) {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false });
          } else {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              child.kill('SIGKILL');
            }
          }
        }
      }, this.gracefulTimeoutMs);
    }, invocation.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutReceived += chunk.length;
      captureBounded(stdoutChunks, stdoutBytes, this.maxCaptureBytes, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrReceived += chunk.length;
      captureBounded(stderrChunks, stderrBytes, this.maxCaptureBytes, chunk);
    });

    const exit = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.on('error', () => {
          resolve({ exitCode: 1, signal: null });
        });
        child.on('close', (exitCode, signal) => {
          resolve({ exitCode, signal });
        });
      },
    );

    clearTimeout(timeoutHandle);
    const durationMs = performance.now() - startedAt;

    const stdoutBuffer = Buffer.concat(stdoutChunks);
    const stderrBuffer = Buffer.concat(stderrChunks);
    const stdoutMeta: BoundedStreamMetadata = {
      bytesCaptured: stdoutBuffer.length,
      truncated: stdoutReceived > stdoutBuffer.length,
      sha256: hashBuffer(stdoutBuffer),
    };
    const stderrMeta: BoundedStreamMetadata = {
      bytesCaptured: stderrBuffer.length,
      truncated: stderrReceived > stderrBuffer.length,
      sha256: hashBuffer(stderrBuffer),
    };

    const stdoutPath = join(this.logDir ?? invocation.cwd, 'stdout.log');
    const stderrPath = join(this.logDir ?? invocation.cwd, 'stderr.log');
    if (this.logDir !== undefined) {
      await mkdir(dirname(stdoutPath), { recursive: true });
      await writeFile(stdoutPath, redactSecrets(stdoutBuffer.toString('utf8')), 'utf8');
      await writeFile(stderrPath, redactSecrets(stderrBuffer.toString('utf8')), 'utf8');
    }

    return {
      exitCode: timeoutState.timedOut ? null : exit.exitCode,
      signal: timeoutState.timedOut ? 'SIGTERM' : exit.signal,
      durationMs,
      stdout: stdoutMeta,
      stderr: stderrMeta,
      stdoutPath,
      stderrPath,
    };
  }
}
