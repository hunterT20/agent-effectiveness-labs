import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type {
  AgentAdapter,
  AgentInvocationInput,
  ArmDocument,
  FixtureDocument,
  ProcessInvocation,
  SuiteDocument,
  TrialPlanEntry,
} from '@ael/core';

import {
  createCustomCommandAdapter,
  FAKE_AGENT_ADAPTER_ID,
} from '../../src/adapters/customCommand.js';
import { DirectoryOnlyIsolationProvider } from '../../src/isolation/directoryOnly.js';
import { runTrial } from '../../src/runner/trialRunner.js';
import { createTempSeedRepo } from '../helpers/tempSeedRepo.js';

const fakeAgentPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../tests/fake-agent/fake-agent.mjs',
);

function suiteDocument(commit: string): SuiteDocument {
  return {
    schemaVersion: 1,
    id: 'suite',
    name: 'suite',
    repository: { type: 'local-git', path: './seed-repo', commit },
    agent: {
      adapter: 'fake-agent',
      model: 'fake',
      reasoning: 'standard',
      permissionMode: 'workspace-write',
    },
    isolation: { provider: 'directory-only', require: {}, network: 'deny' },
    defaults: {
      repeats: 1,
      concurrency: 1,
      timeoutMs: 10_000,
      randomSeed: 'seed',
      cachePolicy: 'cold-isolated',
    },
    primaryControlArm: 'baseline',
    primaryTreatmentArm: 'treatment',
    arms: ['./arms/baseline.yaml'],
    fixtures: ['./fixtures/a/fixture.yaml'],
    decisionPolicy: {
      mode: 'exploratory',
      minimumCompletedPairs: 1,
      minimumIndependentFixtures: 1,
      maximumInfrastructureFailureRate: 1,
      verifiedSuccessDeltaMin: 0,
      pairedImprovementPValueMax: 1,
      multipleComparisonMethod: 'none',
      treatmentCriticalSafetyMax: 0,
      treatmentStaleEvidenceAcceptedMax: 1,
      treatmentRecoveryRateMin: 0,
      treatmentFalseBlockRateMax: 1,
      telemetryCoverageMin: 0,
      treatmentToControlCostPerSuccessMaxRatio: 1,
      treatmentToControlMedianDurationMaxRatio: 10,
      treatmentToControlMedianTokensMaxRatio: 10,
    },
  };
}

function fixtureDocument(overrides: Partial<FixtureDocument> = {}): FixtureDocument {
  return {
    schemaVersion: 1,
    id: 'fix',
    name: 'fix',
    category: 'basic',
    outcomeMode: 'repository',
    phases: [{ id: 'initial', promptFile: './prompts/initial.md', session: 'new' }],
    limits: { timeoutMsPerPhase: 8_000, maxChangedFiles: 5 },
    candidate: { allowedPaths: ['src/**'], forbiddenPaths: ['grader/**'] },
    grading: {
      deterministic: [
        { id: 'answer-check', command: 'node', args: ['./grader/check.mjs'], required: true },
      ],
      blindedRubric: {
        enabled: false,
        rubricFile: null,
        minimumRaters: 0,
        minimumAgreement: null,
      },
      llmJudge: { role: 'disabled' },
    },
    reference: {},
    ...overrides,
  };
}

function armDocument(actions: ArmDocument['actions']): ArmDocument {
  return { schemaVersion: 1, id: 'baseline', name: 'Baseline', actions };
}

const planEntry: TrialPlanEntry = {
  trialIndex: 0,
  blockIndex: 0,
  fixtureId: 'fix',
  armId: 'baseline',
  repeatIndex: 0,
};

function writeFixtureRoot(mode: string): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ael-fx-'));
  mkdirSync(join(fixtureRoot, 'prompts'), { recursive: true });
  mkdirSync(join(fixtureRoot, 'grader'), { recursive: true });
  writeFileSync(
    join(fixtureRoot, 'prompts', 'initial.md'),
    `<!-- ael-fake-mode: ${mode} -->\nFix the answer.\n`,
    'utf8',
  );
  writeFileSync(
    join(fixtureRoot, 'grader', 'check.mjs'),
    `import { existsSync, readFileSync } from 'node:fs';
const p = 'src/answer.txt';
if (!existsSync(p)) { console.log(JSON.stringify({ pass: false })); process.exit(1); }
if (readFileSync(p, 'utf8').trim() !== 'correct-answer') {
  console.log(JSON.stringify({ pass: false })); process.exit(1);
}
console.log(JSON.stringify({ pass: true })); process.exit(0);
`,
    'utf8',
  );
  return fixtureRoot;
}

describe('createCustomCommandAdapter capabilities', () => {
  it('defaults resume:true for fake-agent and honors an explicit capabilities option', () => {
    const fake = createCustomCommandAdapter(FAKE_AGENT_ADAPTER_ID, {
      command: process.execPath,
      extraArgs: [fakeAgentPath],
      timeoutMs: 1000,
    });
    expect(fake.capabilities?.resume).toBe(true);

    const custom = createCustomCommandAdapter('other', {
      command: process.execPath,
      extraArgs: [fakeAgentPath],
      timeoutMs: 1000,
      capabilities: { resume: false, streamJsonTelemetry: false, sandboxProbe: false },
    });
    expect(custom.capabilities?.resume).toBe(false);
  });

  it('merges arm environment, argvAdditions, and pluginDirs into the invocation', async () => {
    const adapter = createCustomCommandAdapter('fake-agent', {
      command: process.execPath,
      extraArgs: [fakeAgentPath],
      timeoutMs: 1000,
    });
    const workspace = mkdtempSync(join(tmpdir(), 'ael-inv-ws-'));
    const invocation = await adapter.buildInvocation({
      workspaceRoot: workspace,
      promptFile: '/tmp/prompt.md',
      phaseId: 'initial',
      sessionMode: 'new',
      environment: { AEL_ARM_MARKER: 'treatment' },
      argvAdditions: ['--hint', 'treatment'],
      pluginDirs: ['/tmp/plugin-dir'],
      timeoutMs: 5000,
    });
    expect(invocation.env.AEL_ARM_MARKER).toBe('treatment');
    expect(invocation.args).toContain('--hint');
    expect(invocation.args).toContain('treatment');
    expect(invocation.args).toContain('--plugin-dir');
    expect(invocation.args).toContain('/tmp/plugin-dir');
    expect(invocation.timeoutMs).toBe(5000);
    expect(invocation.args).toContain('/tmp/prompt.md');
  });
});

describe('runTrial', () => {
  it('applies arm env/argv/pluginDirs, isolates home, and excludes prompts from the snapshot', async () => {
    const seed = await createTempSeedRepo();
    const suiteRoot = mkdtempSync(join(tmpdir(), 'ael-suite-'));
    mkdirSync(join(suiteRoot, 'plugins', 'example'), { recursive: true });
    writeFileSync(join(suiteRoot, 'plugins', 'example', 'p.json'), '{}\n', 'utf8');
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-exp-'));
    const adapter = createCustomCommandAdapter(FAKE_AGENT_ADAPTER_ID, {
      command: process.execPath,
      extraArgs: [fakeAgentPath],
      timeoutMs: 8_000,
    });
    const result = await runTrial({
      experimentRoot,
      trialId: 'trial-1',
      attemptId: 'attempt-1',
      suite: suiteDocument(seed.commit),
      suiteRoot,
      fixture: fixtureDocument(),
      fixtureRoot: writeFixtureRoot('success'),
      arm: armDocument([
        { type: 'environment', variables: { AEL_ARM_MARKER: 'baseline' } },
        { type: 'agent-argument', args: ['--hint', 'x'] },
        { type: 'plugin-directory', path: './plugins/example' },
      ]),
      planEntry,
      adapter,
      isolation: new DirectoryOnlyIsolationProvider(),
      sourceRepositoryPath: seed.repoPath,
    });

    expect(result.status).toBe('completed');
    expect(result.gradeStatus).toBe('verified_success');
    const materialization = JSON.parse(
      readFileSync(
        join(experimentRoot, 'trials', 'trial-1', 'attempt-1', 'arm-materialization.json'),
        'utf8',
      ),
    ) as { environment: Record<string, string>; argvAdditions: string[]; pluginDirs: string[] };
    expect(materialization.environment.AEL_ARM_MARKER).toBe('baseline');
    expect(materialization.argvAdditions).toEqual(['--hint', 'x']);
    expect(materialization.pluginDirs).toHaveLength(1);

    const stdout = readFileSync(
      join(experimentRoot, 'attempts', 'trial-1', 'attempt-1', 'logs', 'stdout.log'),
      'utf8',
    );
    expect(stdout).toContain('AEL_ARM_MARKER=baseline');

    const snapshot = JSON.parse(
      readFileSync(
        join(experimentRoot, 'attempts', 'trial-1', 'attempt-1', 'candidate-snapshot.json'),
        'utf8',
      ),
    ) as { changedFiles: Array<{ path: string }> };
    expect(snapshot.changedFiles.some((entry) => entry.path.includes('prompt'))).toBe(false);
    expect(snapshot.changedFiles.some((entry) => entry.path.startsWith('.ael'))).toBe(false);
  });

  it('never lets per-trial adapter failures propagate', async () => {
    const seed = await createTempSeedRepo();
    const exploding: AgentAdapter = {
      id: 'boom',
      contractVersion: 1,
      doctor: () => Promise.resolve({ ready: true, messages: [] }),
      buildInvocation: (_input: AgentInvocationInput): Promise<ProcessInvocation> => {
        throw new Error('adapter exploded');
      },
      parseOutcome: () => Promise.resolve({ completed: false, responseArtifactPaths: [] }),
      collectTelemetry: () =>
        Promise.resolve({
          inputTokens: { value: null, quality: 'unavailable', source: 'x', coverageReason: 'x' },
          outputTokens: { value: null, quality: 'unavailable', source: 'x', coverageReason: 'x' },
          cachedInputTokens: {
            value: null,
            quality: 'unavailable',
            source: 'x',
            coverageReason: 'x',
          },
          reasoningTokens: {
            value: null,
            quality: 'unavailable',
            source: 'x',
            coverageReason: 'x',
          },
          subagentTokens: { value: null, quality: 'unavailable', source: 'x', coverageReason: 'x' },
          toolCalls: { value: null, quality: 'unavailable', source: 'x', coverageReason: 'x' },
        }),
    };

    const result = await runTrial({
      experimentRoot: mkdtempSync(join(tmpdir(), 'ael-boom-')),
      trialId: 'trial-boom',
      attemptId: 'attempt-1',
      suite: suiteDocument(seed.commit),
      suiteRoot: mkdtempSync(join(tmpdir(), 'ael-boom-suite-')),
      fixture: fixtureDocument(),
      fixtureRoot: writeFixtureRoot('success'),
      arm: armDocument([]),
      planEntry,
      adapter: exploding,
      isolation: new DirectoryOnlyIsolationProvider(),
      sourceRepositoryPath: seed.repoPath,
    });
    expect(result.status).toBe('infrastructure_failed');
    expect(result.gradeStatus).toBe('invalid_trial');
    expect(result.failureReason).toContain('adapter exploded');
  });

  it('sets GradeReport.scopeViolation when allowedPaths are exceeded', async () => {
    const seed = await createTempSeedRepo();
    const result = await runTrial({
      experimentRoot: mkdtempSync(join(tmpdir(), 'ael-scope-')),
      trialId: 'trial-scope',
      attemptId: 'attempt-1',
      suite: suiteDocument(seed.commit),
      suiteRoot: mkdtempSync(join(tmpdir(), 'ael-scope-suite-')),
      fixture: fixtureDocument({
        candidate: { allowedPaths: ['src/**'], forbiddenPaths: ['notes.txt'] },
      }),
      fixtureRoot: writeFixtureRoot('untracked'),
      arm: armDocument([]),
      planEntry,
      adapter: createCustomCommandAdapter(FAKE_AGENT_ADAPTER_ID, {
        command: process.execPath,
        extraArgs: [fakeAgentPath],
        timeoutMs: 8_000,
      }),
      isolation: new DirectoryOnlyIsolationProvider(),
      sourceRepositoryPath: seed.repoPath,
    });
    expect(result.gradeReport?.scopeViolation).toBe(true);
    expect(result.gradeStatus).toBe('incorrect');
  });

  it('reports timed_out when the fake agent hangs', async () => {
    const seed = await createTempSeedRepo();
    const result = await runTrial({
      experimentRoot: mkdtempSync(join(tmpdir(), 'ael-to-')),
      trialId: 'trial-timeout',
      attemptId: 'attempt-1',
      suite: suiteDocument(seed.commit),
      suiteRoot: mkdtempSync(join(tmpdir(), 'ael-to-suite-')),
      fixture: fixtureDocument({
        limits: { timeoutMsPerPhase: 500, maxChangedFiles: 5 },
      }),
      fixtureRoot: writeFixtureRoot('timeout'),
      arm: armDocument([]),
      planEntry,
      adapter: createCustomCommandAdapter(FAKE_AGENT_ADAPTER_ID, {
        command: process.execPath,
        extraArgs: [fakeAgentPath],
        timeoutMs: 500,
      }),
      isolation: new DirectoryOnlyIsolationProvider(),
      sourceRepositoryPath: seed.repoPath,
    });
    expect(result.status).toBe('timed_out');
    expect(result.gradeStatus).toBe('incorrect');
  });
});
