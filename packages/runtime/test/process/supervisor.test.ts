import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { DEFAULT_MAX_CAPTURE_BYTES, ProcessSupervisor } from '../../src/process/supervisor.js';

const isWindows = process.platform === 'win32';
const tempDirs: string[] = [];

function makeLogDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function nodeInvocation(script: string, timeoutMs = 10_000) {
  return {
    command: process.execPath,
    args: ['-e', script],
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? '' },
    timeoutMs,
  };
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}

describe('ProcessSupervisor', () => {
  it('spawns with an argv array (no shell interpretation) and reports a clean exit', async () => {
    const logDir = makeLogDir('ael-sup-argv-');
    const supervisor = new ProcessSupervisor({ logDir });
    // If a shell were involved, `$HOME` and `;` would be interpreted. They must arrive verbatim.
    const result = await supervisor.run({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv.slice(1).join("|"))', '$HOME', 'a; echo b'],
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.terminationReason).toBe('exited');
    expect(readFileSync(result.stdoutPath, 'utf8')).toBe('$HOME|a; echo b');
    expect(result.stdout.truncated).toBe(false);
  });

  it('measures durationMs with a monotonic high-resolution clock', async () => {
    const supervisor = new ProcessSupervisor();
    const result = await supervisor.run(nodeInvocation('setTimeout(() => {}, 200)'));
    expect(result.exitCode).toBe(0);
    expect(Number.isFinite(result.durationMs)).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(150);
    expect(result.durationMs).toBeLessThan(10_000);
  });

  it('terminates on timeout with SIGTERM, escalates to SIGKILL, and reports the signal', async () => {
    const supervisor = new ProcessSupervisor({ gracefulTimeoutMs: 200 });
    // Ignore SIGTERM so only SIGKILL can end the process.
    const result = await supervisor.run(
      nodeInvocation('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);', 300),
    );

    expect(result.terminationReason).toBe('timeout');
    expect(result.exitCode).toBeNull();
    expect(result.signal).not.toBeNull();
    if (!isWindows) {
      expect(result.signal).toBe('SIGKILL');
    }
  });

  it.skipIf(isWindows)('kills the whole process group, including grandchildren', async () => {
    const logDir = makeLogDir('ael-sup-group-');
    const supervisor = new ProcessSupervisor({ logDir, gracefulTimeoutMs: 200 });
    const script = [
      'const { spawn } = require("node:child_process");',
      'const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'sleeper.unref();',
      'process.stdout.write(String(sleeper.pid) + "\\n");',
      'setInterval(() => {}, 1000);',
    ].join('\n');

    const result = await supervisor.run(nodeInvocation(script, 500));
    expect(result.terminationReason).toBe('timeout');
    const sleeperPid = Number.parseInt(readFileSync(result.stdoutPath, 'utf8').trim(), 10);
    expect(Number.isInteger(sleeperPid)).toBe(true);

    expect(await waitForDeath(sleeperPid, 3_000)).toBe(true);
  });

  it('bounds captured output at 4 MiB by default and records truncation + sha256', async () => {
    const logDir = makeLogDir('ael-sup-bound-');
    const supervisor = new ProcessSupervisor({ logDir });
    const fiveMiB = 5 * 1024 * 1024;
    const result = await supervisor.run(
      nodeInvocation(`process.stdout.write(Buffer.alloc(${fiveMiB}, 0x61))`),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.truncated).toBe(true);
    expect(result.stdout.bytesCaptured).toBe(DEFAULT_MAX_CAPTURE_BYTES);
    expect(statSync(result.stdoutPath).size).toBe(DEFAULT_MAX_CAPTURE_BYTES);
    expect(result.stdout.sha256).toBe(sha256(readFileSync(result.stdoutPath)));
    expect(result.stderr.truncated).toBe(false);
    expect(result.stderr.bytesCaptured).toBe(0);
  });

  it('respects a custom maxCaptureBytes for stderr too', async () => {
    const logDir = makeLogDir('ael-sup-bound2-');
    const supervisor = new ProcessSupervisor({ logDir, maxCaptureBytes: 16 });
    const result = await supervisor.run(
      nodeInvocation('process.stderr.write("0123456789abcdefghijklmnop")'),
    );
    expect(result.stderr.truncated).toBe(true);
    expect(result.stderr.bytesCaptured).toBe(16);
    expect(readFileSync(result.stderrPath, 'utf8')).toBe('0123456789abcdef');
  });

  it('redacts secrets before writing to disk and hashes the redacted bytes', async () => {
    const logDir = makeLogDir('ael-sup-redact-');
    const literal = 'hunter2-literal-secret-value';
    const supervisor = new ProcessSupervisor({ logDir, redactLiterals: [literal] });
    const script =
      'process.stdout.write("api_key=PATTERNSECRET123 done\\n");' +
      `process.stdout.write("token is ${literal} ok\\n");` +
      'process.stderr.write("Authorization: Bearer abc.def.ghi\\n");';
    const result = await supervisor.run(nodeInvocation(script));

    const stdoutFile = readFileSync(result.stdoutPath);
    const stderrFile = readFileSync(result.stderrPath);
    const stdoutText = stdoutFile.toString('utf8');
    expect(stdoutText).not.toContain('PATTERNSECRET123');
    expect(stdoutText).not.toContain(literal);
    expect(stdoutText).toContain('[REDACTED]');
    expect(stdoutText).toContain('done');
    expect(stderrFile.toString('utf8')).not.toContain('abc.def.ghi');

    // Metadata describes the redacted bytes that were actually persisted.
    expect(result.stdout.sha256).toBe(sha256(stdoutFile));
    expect(result.stdout.bytesCaptured).toBe(stdoutFile.length);
    expect(result.stderr.sha256).toBe(sha256(stderrFile));
    expect(result.stderr.bytesCaptured).toBe(stderrFile.length);
  });

  it('accepts per-run redactLiterals in addition to supervisor-level ones', async () => {
    const logDir = makeLogDir('ael-sup-redact2-');
    const supervisor = new ProcessSupervisor({ logDir, redactLiterals: ['first-secret-value'] });
    const result = await supervisor.run(
      nodeInvocation('process.stdout.write("first-secret-value second-secret-value")'),
      { redactLiterals: ['second-secret-value'] },
    );
    expect(readFileSync(result.stdoutPath, 'utf8')).toBe('[REDACTED] [REDACTED]');
  });

  it('terminates on abort with terminationReason "aborted"', async () => {
    const supervisor = new ProcessSupervisor({ gracefulTimeoutMs: 200 });
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 150);
    const result = await supervisor.run(nodeInvocation('setInterval(() => {}, 1000)', 10_000), {
      signal: controller.signal,
    });

    expect(result.terminationReason).toBe('aborted');
    expect(result.exitCode).toBeNull();
    expect(result.signal).not.toBeNull();
    expect(result.durationMs).toBeLessThan(5_000);
  });

  it('terminates immediately when the signal is already aborted', async () => {
    const supervisor = new ProcessSupervisor({ gracefulTimeoutMs: 200 });
    const result = await supervisor.run(nodeInvocation('setInterval(() => {}, 1000)', 10_000), {
      signal: AbortSignal.abort(),
    });
    expect(result.terminationReason).toBe('aborted');
    expect(result.exitCode).toBeNull();
  });

  it('reports exited with the real exit code when the process ends on its own', async () => {
    const supervisor = new ProcessSupervisor();
    const result = await supervisor.run(nodeInvocation('process.exit(3)'));
    expect(result.terminationReason).toBe('exited');
    expect(result.exitCode).toBe(3);
    expect(result.signal).toBeNull();
  });
});
