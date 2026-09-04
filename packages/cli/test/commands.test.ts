import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  doctorCommand,
  planCommand,
  resumeCommand,
  runCommand,
  statusCommand,
  validateSuiteCommand,
  writeLiveApprovalJson,
} from '../src/commands/index.js';
import { EXIT_CAPABILITY, EXIT_CONFIG, EXIT_OK } from '../src/exitCodes.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const examplesRoot = join(repoRoot, 'examples/minimal');
const suitePath = join(examplesRoot, 'suite.yaml');
const suiteCursorPath = join(examplesRoot, 'suite-cursor.yaml');
const awhSuitePath = join(repoRoot, 'examples/awh-vs-baseline/suite.yaml');
const fakeAgentPath = join(repoRoot, 'tests/fake-agent/fake-agent.mjs');

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout: (message: string) => stdout.push(message),
    stderr: (message: string) => stderr.push(message),
    stdoutText: () => stdout.join(''),
    stderrText: () => stderr.join(''),
    all: () => `${stdout.join('')}${stderr.join('')}`,
  };
}

describe('cli commands', () => {
  it('validates the minimal suite', () => {
    const logs: string[] = [];
    const code = validateSuiteCommand(suitePath, {
      stdout: (message) => logs.push(message),
      stderr: () => undefined,
    });
    expect(code).toBe(EXIT_OK);
    expect(logs.join('')).toContain('suite valid');
  });

  it('plans without invoking an agent', () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'ael-plan-'));
    const logs: string[] = [];
    const code = planCommand(
      suitePath,
      outputRoot,
      {
        stdout: (message) => logs.push(message),
        stderr: (message) => logs.push(message),
      },
      true,
    );
    expect(code).toBe(EXIT_OK);
    expect(logs.join('')).toContain('trials');
  });

  it('returns EXIT_CAPABILITY when a fixture needs resume and the adapter lacks it', () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'ael-plan-resume-'));
    const ctx = capture();
    const code = planCommand(awhSuitePath, outputRoot, ctx, false);
    expect(code).toBe(EXIT_CAPABILITY);
    expect(ctx.stderrText()).toContain('capabilities.resume');
    expect(existsSync(join(outputRoot, 'trial-plan.json'))).toBe(false);
  });

  it('prints each ConfigValidationError issue with fieldPath, code, and message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ael-bad-suite-'));
    const badSuite = join(dir, 'suite.yaml');
    writeFileSync(badSuite, 'schemaVersion: 99\nunknownField: true\n', 'utf8');
    const ctx = capture();
    const code = validateSuiteCommand(badSuite, ctx);
    expect(code).toBe(EXIT_CONFIG);
    expect(ctx.stderrText()).toMatch(/\S+ AEL_CONFIG_\S+ /);
  });

  it('refuses cursor run without live approval and does not write live-approval.json', async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'ael-run-cursor-'));
    const previous = process.env.AEL_APPROVE_LIVE_RUN;
    delete process.env.AEL_APPROVE_LIVE_RUN;
    const ctx = capture();
    try {
      const code = await runCommand(suiteCursorPath, outputRoot, fakeAgentPath, ctx);
      expect(code).toBe(EXIT_CAPABILITY);
      expect(ctx.stderrText()).toContain('approve-live-run');
      expect(existsSync(join(outputRoot, 'live-approval.json'))).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.AEL_APPROVE_LIVE_RUN;
      } else {
        process.env.AEL_APPROVE_LIVE_RUN = previous;
      }
    }
  });

  it('returns EXIT_CONFIG rather than EXIT_RUNTIME for a missing suite on run', async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'ael-run-missing-'));
    const ctx = capture();
    const code = await runCommand(
      join(outputRoot, 'no-such-suite.yaml'),
      outputRoot,
      fakeAgentPath,
      ctx,
    );
    expect(code).toBe(EXIT_CONFIG);
  });

  it('writes live-approval.json with method flag or env', () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'ael-approval-'));
    const record = writeLiveApprovalJson(outputRoot, 'flag');
    expect(record.method).toBe('flag');
    expect(record.approvedBy.length).toBeGreaterThan(0);
    const raw: unknown = JSON.parse(readFileSync(join(outputRoot, 'live-approval.json'), 'utf8'));
    expect(raw).toMatchObject({ method: 'flag' });
  });

  it('resume does not re-plan when trial-plan.json is missing', async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'ael-resume-missing-'));
    const ctx = capture();
    const code = await resumeCommand(suitePath, outputRoot, fakeAgentPath, ctx);
    expect(code).toBe(EXIT_CONFIG);
    expect(existsSync(join(outputRoot, 'trial-plan.json'))).toBe(false);
  });

  it('status scans attempts/*/*/state.json and prints JSON on stdout when --json', () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'ael-status-'));
    const planCode = planCommand(suitePath, outputRoot, capture(), false);
    expect(planCode).toBe(EXIT_OK);
    const attemptDir = join(outputRoot, 'attempts', 'trial-a', 'attempt-001');
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(
      join(attemptDir, 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        trialId: 'trial-a',
        attemptId: 'attempt-001',
        status: 'completed',
      }),
      'utf8',
    );
    const ctx = capture();
    const code = statusCommand(outputRoot, ctx, true);
    expect(code).toBe(EXIT_OK);
    expect(ctx.stdoutText()).toContain('"completed": 1');
    expect(ctx.stderrText()).toBe('');
    const payload: unknown = JSON.parse(ctx.stdoutText());
    expect(payload).toMatchObject({ plannedTrials: 6, attemptCount: 1 });
  });

  it('status human text goes to stderr', () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'ael-status-human-'));
    expect(planCommand(suitePath, outputRoot, capture(), false)).toBe(EXIT_OK);
    const ctx = capture();
    const code = statusCommand(outputRoot, ctx, false);
    expect(code).toBe(EXIT_OK);
    expect(ctx.stderrText()).toContain('planned-trials=');
    expect(ctx.stdoutText()).toBe('');
  });

  it('doctor prints model, trials, timeout, advisory cost, and fairness warnings', async () => {
    const ctx = capture();
    const code = await doctorCommand(suitePath, ctx);
    expect(code).toBe(EXIT_OK);
    expect(ctx.all()).toContain('model=');
    expect(ctx.all()).toContain('trials=');
    expect(ctx.all()).toContain('timeout-ms=');
    expect(ctx.all()).toContain('advisory-max-cost-usd=');
  });
});
