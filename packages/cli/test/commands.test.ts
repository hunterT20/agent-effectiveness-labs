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

  it('plans the awh-vs-baseline suite with fake-agent resume support', () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'ael-plan-awh-'));
    const ctx = capture();
    const code = planCommand(awhSuitePath, outputRoot, ctx, false);
    expect(code).toBe(EXIT_OK);
    expect(existsSync(join(outputRoot, 'trial-plan.json'))).toBe(true);
  });

  it('returns EXIT_CAPABILITY when a fixture needs resume and the adapter lacks it', () => {
    const suiteRoot = mkdtempSync(join(tmpdir(), 'ael-plan-no-resume-'));
    mkdirSync(join(suiteRoot, 'arms'), { recursive: true });
    mkdirSync(join(suiteRoot, 'fixtures/resume-me/prompts'), { recursive: true });
    mkdirSync(join(suiteRoot, 'fixtures/resume-me/grader'), { recursive: true });
    mkdirSync(join(suiteRoot, 'fixtures/resume-me/reference'), { recursive: true });
    mkdirSync(join(suiteRoot, 'seed'), { recursive: true });
    writeFileSync(join(suiteRoot, 'seed', 'README.md'), 'seed\n', 'utf8');
    writeFileSync(
      join(suiteRoot, 'arms/baseline.yaml'),
      'schemaVersion: 1\nid: baseline\nname: Baseline\nactions: []\n',
      'utf8',
    );
    writeFileSync(join(suiteRoot, 'fixtures/resume-me/prompts/initial.md'), 'start\n', 'utf8');
    writeFileSync(join(suiteRoot, 'fixtures/resume-me/prompts/recovery.md'), 'resume\n', 'utf8');
    writeFileSync(
      join(suiteRoot, 'fixtures/resume-me/grader/check.mjs'),
      'process.exit(0);\n',
      'utf8',
    );
    writeFileSync(join(suiteRoot, 'fixtures/resume-me/reference/solution.patch'), '', 'utf8');
    writeFileSync(
      join(suiteRoot, 'fixtures/resume-me/fixture.yaml'),
      `schemaVersion: 1
id: resume-me
name: Resume required
category: recovery
outcomeMode: repository
phases:
  - id: initial
    promptFile: ./prompts/initial.md
    session: new
  - id: recovery
    promptFile: ./prompts/recovery.md
    session: resume
limits:
  timeoutMsPerPhase: 1000
  maxChangedFiles: 4
candidate:
  allowedPaths:
    - src/**
  forbiddenPaths:
    - grader/**
grading:
  deterministic:
    - id: check
      command: node
      args: [./grader/check.mjs]
      required: true
  blindedRubric:
    enabled: false
    rubricFile: null
    minimumRaters: 0
    minimumAgreement: null
  llmJudge:
    role: disabled
reference:
  solutionPatch: ./reference/solution.patch
`,
      'utf8',
    );
    writeFileSync(
      join(suiteRoot, 'suite.yaml'),
      `schemaVersion: 1
id: no-resume-suite
name: No resume adapter
repository:
  type: local-git
  path: ./seed
  commit: 0123456789abcdef0123456789abcdef01234567
agent:
  adapter: no-resume-agent
  model: fake
  reasoning: standard
  permissionMode: workspace-write
isolation:
  provider: directory-only
  require: {}
  network: deny
defaults:
  repeats: 1
  concurrency: 1
  timeoutMs: 1000
  randomSeed: no-resume
  cachePolicy: cold-isolated
primaryControlArm: baseline
primaryTreatmentArm: baseline
arms:
  - ./arms/baseline.yaml
fixtures:
  - ./fixtures/resume-me/fixture.yaml
decisionPolicy:
  mode: exploratory
  minimumCompletedPairs: 1
  minimumIndependentFixtures: 1
  maximumInfrastructureFailureRate: 1
  verifiedSuccessDeltaMin: 0
  pairedImprovementPValueMax: 1
  multipleComparisonMethod: none
  treatmentCriticalSafetyMax: 0
  treatmentStaleEvidenceAcceptedMax: 1
  treatmentRecoveryRateMin: 0
  treatmentFalseBlockRateMax: 1
  telemetryCoverageMin: 0
  treatmentToControlCostPerSuccessMaxRatio: 1
  treatmentToControlMedianDurationMaxRatio: 10
  treatmentToControlMedianTokensMaxRatio: 10
`,
      'utf8',
    );
    const outputRoot = mkdtempSync(join(tmpdir(), 'ael-plan-resume-'));
    const ctx = capture();
    const code = planCommand(join(suiteRoot, 'suite.yaml'), outputRoot, ctx, false);
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
    expect(payload).toMatchObject({ plannedTrials: 18, attemptCount: 1 });
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
