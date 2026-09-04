import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CURSOR_ENV_ALLOWLIST,
  CURSOR_PROBE_LIVE_GATE_MESSAGE,
  CURSOR_VERSION_TIMEOUT_MS,
  createCursorAdapter,
  evaluateProbeEvidence,
  extractCursorTelemetry,
  parseCursorAgentVersion,
  probeCursorSandbox,
  redactCursorArgv,
  resetCursorSandboxProbeCache,
} from '@ael/runtime';

const fixturesRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../tests/fixtures/cursor-logs',
);

function writeWorkspace(promptBody = 'fix the failing test'): {
  readonly workspaceRoot: string;
  readonly isolatedHomeRoot: string;
  readonly promptFile: string;
} {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'ael-cursor-ws-'));
  const promptFile = '.ael/prompt-initial.md';
  mkdirSync(join(workspaceRoot, '.ael'), { recursive: true });
  writeFileSync(join(workspaceRoot, promptFile), promptBody, 'utf8');
  const isolatedHomeRoot = join(workspaceRoot, '.ael', 'isolated-home', 'trial-1');
  return { workspaceRoot, isolatedHomeRoot, promptFile };
}

function writeFakeCursorAgent(versionLine: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ael-fake-cursor-bin-'));
  const script = join(dir, 'cursor-agent');
  writeFileSync(script, `#!/bin/sh\necho '${versionLine}'\n`, { mode: 0o755 });
  chmodSync(script, 0o755);
  return script;
}

describe('cursor adapter', () => {
  afterEach(() => {
    resetCursorSandboxProbeCache();
    delete process.env.AEL_ALLOW_UNTESTED_CURSOR;
  });

  it('parses supported version ranges', () => {
    const version = parseCursorAgentVersion('2026.09.02-c22c1a3');
    expect(version.supported).toBe(true);
    const legacy = parseCursorAgentVersion('2025.01.01-deadbeef');
    expect(legacy.supported).toBe(false);
  });

  it('times out version reads after 5 seconds', () => {
    expect(CURSOR_VERSION_TIMEOUT_MS).toBe(5_000);
  });

  it('builds argv-safe invocation with isolated home and positional prompt content', async () => {
    const { workspaceRoot, isolatedHomeRoot, promptFile } = writeWorkspace('fix the failing test');
    const adapter = createCursorAdapter({
      model: 'composer-2.5',
      timeoutMs: 30_000,
      command: 'cursor-agent',
      skipVersionCheck: true,
      skipSandboxProbe: true,
    });
    const invocation = await adapter.buildInvocation({
      workspaceRoot,
      promptFile,
      phaseId: 'initial',
      sessionMode: 'new',
      trialId: 'trial-1',
      isolatedHomeRoot,
    });
    expect(invocation.command).toBe('cursor-agent');
    expect(invocation.args).toContain('--print');
    expect(invocation.args).toContain('--output-format');
    expect(invocation.args).toContain('stream-json');
    expect(invocation.args).toContain('--sandbox');
    expect(invocation.args).toContain('enabled');
    expect(invocation.args).toContain('--trust');
    expect(invocation.args).toContain('--workspace');
    expect(invocation.args).toContain(workspaceRoot);
    expect(invocation.args).toContain('--model');
    expect(invocation.args).toContain('composer-2.5');
    expect(invocation.args.at(-1)).toBe('fix the failing test');
    expect(invocation.args.some((arg) => arg.startsWith('@'))).toBe(false);
    expect(invocation.env.HOME).toBe(join(isolatedHomeRoot, 'home'));
    expect(invocation.env.XDG_CONFIG_HOME).toContain('isolated-home');
    expect(invocation.redactedArgv?.[0]).toBe('cursor-agent');
  });

  it('forwards only the env allowlist and redacts api keys in argv provenance', async () => {
    const previousLeak = process.env.AEL_SECRET_LEAK;
    const previousKey = process.env.CURSOR_API_KEY;
    process.env.AEL_SECRET_LEAK = 'should-not-leak';
    process.env.CURSOR_API_KEY = 'sk-testkeyvalue';
    try {
      const { workspaceRoot, isolatedHomeRoot, promptFile } = writeWorkspace();
      const adapter = createCursorAdapter({
        model: 'composer-2.5',
        timeoutMs: 30_000,
        skipVersionCheck: true,
        skipSandboxProbe: true,
      });
      const invocation = await adapter.buildInvocation({
        workspaceRoot,
        promptFile,
        phaseId: 'initial',
        sessionMode: 'new',
        trialId: 'trial-1',
        isolatedHomeRoot,
      });
      expect(invocation.env.AEL_SECRET_LEAK).toBeUndefined();
      expect(invocation.env.CURSOR_API_KEY).toBe('sk-testkeyvalue');
      expect(CURSOR_ENV_ALLOWLIST).toContain('CURSOR_API_KEY');
      expect(redactCursorArgv('cursor-agent', ['--api-key', 'sk-testkeyvalue'])).toEqual([
        'cursor-agent',
        '--api-key',
        '[REDACTED]',
      ]);
    } finally {
      if (previousLeak === undefined) {
        delete process.env.AEL_SECRET_LEAK;
      } else {
        process.env.AEL_SECRET_LEAK = previousLeak;
      }
      if (previousKey === undefined) {
        delete process.env.CURSOR_API_KEY;
      } else {
        process.env.CURSOR_API_KEY = previousKey;
      }
    }
  });

  it('adds --resume when session mode is resume', async () => {
    const { workspaceRoot, isolatedHomeRoot } = writeWorkspace();
    mkdirSync(join(workspaceRoot, '.ael'), { recursive: true });
    writeFileSync(join(workspaceRoot, '.ael/prompt-recovery.md'), 'recover', 'utf8');
    const adapter = createCursorAdapter({
      model: 'composer-2.5',
      timeoutMs: 30_000,
      skipVersionCheck: true,
      skipSandboxProbe: true,
    });
    const invocation = await adapter.buildInvocation({
      workspaceRoot,
      promptFile: '.ael/prompt-recovery.md',
      phaseId: 'recovery',
      sessionMode: 'resume',
      resumeChatId: 'chat-redacted-001',
      trialId: 'trial-1',
      isolatedHomeRoot,
    });
    expect(invocation.args).toContain('--resume');
    expect(invocation.args).toContain('chat-redacted-001');
  });

  it('declares resume capability', () => {
    const adapter = createCursorAdapter({
      model: 'composer-2.5',
      timeoutMs: 30_000,
      skipSandboxProbe: true,
    });
    expect(adapter.capabilities?.resume).toBe(true);
  });

  it('doctor is not ready when the binary is missing', async () => {
    const adapter = createCursorAdapter({
      command: join(tmpdir(), 'ael-missing-cursor-agent'),
      model: 'composer-2.5',
      timeoutMs: 30_000,
      skipSandboxProbe: true,
    });
    const result = await adapter.doctor({ workspaceRoot: tmpdir() });
    expect(result.ready).toBe(false);
    expect(result.messages.join(' ')).toMatch(/not found|timed out/i);
  });

  it('doctor is not ready for untested versions unless AEL_ALLOW_UNTESTED_CURSOR=1', async () => {
    const command = writeFakeCursorAgent('2025.01.01-legacy');
    const adapter = createCursorAdapter({
      command,
      model: 'composer-2.5',
      timeoutMs: 30_000,
      skipSandboxProbe: true,
    });
    const blocked = await adapter.doctor({ workspaceRoot: tmpdir() });
    expect(blocked.ready).toBe(false);
    process.env.AEL_ALLOW_UNTESTED_CURSOR = '1';
    const allowed = await adapter.doctor({ workspaceRoot: tmpdir() });
    expect(allowed.ready).toBe(true);
    expect(allowed.messages.join(' ')).toContain('untested');
  });

  it('skips the live sandbox probe unless AEL_LIVE_CURSOR=1', async () => {
    expect(process.env.AEL_LIVE_CURSOR).not.toBe('1');
    const result = await probeCursorSandbox({ command: 'cursor-agent' });
    expect(result.status).toBe('skipped');
    expect(result.readHomeBlocked).toBe(false);
    expect(result.messages).toContain(CURSOR_PROBE_LIVE_GATE_MESSAGE);
  });

  it('evaluates probe evidence from the filesystem, not stderr sandbox text', async () => {
    const markerDir = mkdtempSync(join(tmpdir(), 'ael-probe-eval-'));
    const outsideWritePath = join(tmpdir(), `ael-probe-missing-${String(Date.now())}.txt`);
    const leaked = await evaluateProbeEvidence({
      stdout: 'sandbox enabled and working',
      canaryToken: 'AEL_CANARY_secret',
      outsideWritePath,
      markerDir,
    });
    expect(leaked.readHomeBlocked).toBe(false);
    expect(leaked.writeOutsideWorkspaceBlocked).toBe(false);
    expect(leaked.status).toBe('inconclusive');

    writeFileSync(join(markerDir, 'read-home.txt'), 'permission denied\n', 'utf8');
    writeFileSync(join(markerDir, 'write-outside.txt'), '1\n', 'utf8');
    writeFileSync(join(markerDir, 'net-exit.txt'), '7\n', 'utf8');
    const blocked = await evaluateProbeEvidence({
      stdout: 'sandbox enabled',
      canaryToken: 'AEL_CANARY_secret',
      outsideWritePath,
      markerDir,
    });
    expect(blocked.readHomeBlocked).toBe(true);
    expect(blocked.writeOutsideWorkspaceBlocked).toBe(true);
    expect(blocked.networkBlocked).toBe(true);
    expect(blocked.status).toBe('observed');
  });

  it('memoizes a live probe per command and model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ael-probe-memo-'));
    const counter = join(dir, 'count');
    const script = join(dir, 'fake-agent');
    writeFileSync(script, `#!/bin/sh\necho x >> '${counter}'\nexit 0\n`, { mode: 0o755 });
    chmodSync(script, 0o755);
    resetCursorSandboxProbeCache();
    await probeCursorSandbox({ command: script, liveEnabled: true, timeoutMs: 5_000 });
    await probeCursorSandbox({ command: script, liveEnabled: true, timeoutMs: 5_000 });
    const once = readFileSync(counter, 'utf8').trim().split('\n').length;
    expect(once).toBe(1);
    resetCursorSandboxProbeCache();
    await probeCursorSandbox({ command: script, liveEnabled: true, timeoutMs: 5_000 });
    const twice = readFileSync(counter, 'utf8').trim().split('\n').length;
    expect(twice).toBe(2);
  });

  it('extracts exact telemetry from frozen redacted logs without double-counting', () => {
    const stdout = readFileSync(join(fixturesRoot, '2026.09.02/stdout-success.log'), 'utf8');
    const extraction = extractCursorTelemetry(stdout);
    expect(extraction.telemetry.inputTokens.quality).toBe('exact');
    expect(extraction.telemetry.inputTokens.value).toBe(2400);
    expect(extraction.telemetry.outputTokens.value).toBe(640);
    expect(extraction.telemetry.cachedInputTokens.value).toBe(160);
    expect(extraction.telemetry.reasoningTokens.value).toBe(128);
    expect(extraction.telemetry.toolCalls.value).toBe(1);
    expect(extraction.sessionChatId).toBe('chat-redacted-001');
  });

  it('marks unknown telemetry unavailable while retaining partial exact values', () => {
    const stdout = readFileSync(join(fixturesRoot, '2026.09.02/stdout-partial.log'), 'utf8');
    const extraction = extractCursorTelemetry(stdout);
    expect(extraction.telemetry.inputTokens.value).toBe(10);
    expect(extraction.telemetry.outputTokens.value).toBe(5);
    expect(extraction.telemetry.toolCalls.quality).toBe('unavailable');
    expect(extraction.rejectedLines).toBe(2);
  });
});
