import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createCursorAdapter, parseCursorAgentVersion, extractCursorTelemetry } from '@ael/runtime';

const fixturesRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../tests/fixtures/cursor-logs',
);

describe('cursor adapter', () => {
  it('parses supported version ranges', () => {
    const version = parseCursorAgentVersion('2026.09.02-c22c1a3');
    expect(version.supported).toBe(true);
    const legacy = parseCursorAgentVersion('2025.01.01-deadbeef');
    expect(legacy.supported).toBe(false);
  });

  it('builds argv-safe invocation with isolated home and prompt file path', async () => {
    const adapter = createCursorAdapter({
      model: 'composer-2.5',
      timeoutMs: 30_000,
      command: 'cursor-agent',
      skipVersionCheck: true,
      skipSandboxProbe: true,
    });
    const invocation = await adapter.buildInvocation({
      workspaceRoot: '/tmp/ws',
      promptFile: '.ael/prompt-initial.md',
      phaseId: 'initial',
      sessionMode: 'new',
      trialId: 'trial-1',
      isolatedHomeRoot: '/tmp/ws/.ael/isolated-home/trial-1',
    });
    expect(invocation.command).toBe('cursor-agent');
    expect(invocation.args).toContain('--print');
    expect(invocation.args).toContain('--output-format');
    expect(invocation.args).toContain('stream-json');
    expect(invocation.args).toContain('--sandbox');
    expect(invocation.args).toContain('enabled');
    expect(invocation.args).toContain('--trust');
    expect(invocation.args).toContain('--workspace');
    expect(invocation.args).toContain('/tmp/ws');
    expect(invocation.args).toContain('--model');
    expect(invocation.args).toContain('composer-2.5');
    expect(invocation.args.at(-1)).toBe('@/tmp/ws/.ael/prompt-initial.md');
    expect(invocation.env.HOME).toBe('/tmp/ws/.ael/isolated-home/trial-1/home');
    expect(invocation.env.XDG_CONFIG_HOME).toContain('isolated-home');
  });

  it('adds --resume when session mode is resume', async () => {
    const adapter = createCursorAdapter({
      model: 'composer-2.5',
      timeoutMs: 30_000,
      skipVersionCheck: true,
      skipSandboxProbe: true,
    });
    const invocation = await adapter.buildInvocation({
      workspaceRoot: '/tmp/ws',
      promptFile: '.ael/prompt-recovery.md',
      phaseId: 'recovery',
      sessionMode: 'resume',
      resumeChatId: 'chat-redacted-001',
      trialId: 'trial-1',
      isolatedHomeRoot: '/tmp/ws/.ael/isolated-home/trial-1',
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

  it('extracts exact telemetry from frozen redacted logs', () => {
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
  });
});
