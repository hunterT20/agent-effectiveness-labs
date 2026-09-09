import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, beforeAll } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { parseFixtureDocument } from '@ael/core';
import { extractCursorTelemetry } from '../../packages/runtime/src/telemetry/cursorExtractor.js';
import { runFixtureSelfTest } from '../../packages/runtime/src/grading/fixtureValidation.js';
import { runHiddenGrader } from '../../packages/runtime/src/grading/hiddenGrader.js';
import { createCancellationToken } from '../../packages/runtime/src/runner/concurrency.js';
import { ProcessSupervisor } from '../../packages/runtime/src/process/supervisor.js';
import { planCommand } from '../../packages/cli/src/commands/index.js';
import { EXIT_CAPABILITY } from '../../packages/cli/src/exitCodes.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const examplesRoot = join(repoRoot, 'examples/minimal');

describe('examples/minimal fixture self-test (repeatCount 3)', () => {
  let repositoryCommit = '';

  beforeAll(() => {
    const init = spawnSync(process.execPath, [join(examplesRoot, 'scripts/init-seed-repo.mjs')], {
      encoding: 'utf8',
    });
    if (init.status !== 0) {
      throw new Error(init.stderr || 'failed to initialize seed repo');
    }
    repositoryCommit = init.stdout.trim();
  });

  const fixtures = ['fix-a', 'fix-b', 'fix-c'];

  for (const fixtureId of fixtures) {
    it(`${fixtureId} passes self-test with repeatCount 3`, async () => {
      const fixturePath = join(examplesRoot, 'fixtures', fixtureId, 'fixture.yaml');
      const fixture = parseFixtureDocument(parseYaml(readFileSync(fixturePath, 'utf8')), fixturePath);
      const workDir = mkdtempSync(join(tmpdir(), `ael-qual-${fixtureId}-`));
      const result = await runFixtureSelfTest({
        fixture,
        fixtureRoot: join(examplesRoot, 'fixtures', fixtureId),
        seedRepositoryPath: join(examplesRoot, 'seed-repo'),
        repositoryCommit,
        workDir,
        repeatCount: 3,
      });
      expect(result.valid, result.messages.join('; ')).toBe(true);
    }, 60_000);
  }
});

describe('Qualification A fault-injection', () => {
  let repositoryCommit = '';
  let fixture: ReturnType<typeof parseFixtureDocument>;
  let fixtureRoot = '';

  beforeAll(() => {
    const init = spawnSync(process.execPath, [join(examplesRoot, 'scripts/init-seed-repo.mjs')], {
      encoding: 'utf8',
    });
    if (init.status !== 0) {
      throw new Error(init.stderr || 'failed to initialize seed repo');
    }
    repositoryCommit = init.stdout.trim();
    fixtureRoot = join(examplesRoot, 'fixtures', 'fix-a');
    const fixturePath = join(fixtureRoot, 'fixture.yaml');
    fixture = parseFixtureDocument(parseYaml(readFileSync(fixturePath, 'utf8')), fixturePath);
  });

  it('timeout fault-injection terminates a hung child via AbortSignal', async () => {
    const supervisor = new ProcessSupervisor();
    const token = createCancellationToken();
    const hangScript = 'setTimeout(() => {}, 60_000)';
    const runPromise = supervisor.run(
      {
        command: process.execPath,
        args: ['-e', hangScript],
        cwd: tmpdir(),
        env: { PATH: process.env.PATH ?? '' },
        timeoutMs: 60_000,
      },
      { signal: token.signal },
    );
    token.cancel();
    const result = await runPromise;
    expect(result.terminationReason).toBe('aborted');
  });

  it('crash fault-injection maps grader exit != 0/1 to invalid_trial', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'ael-qual-crash-'));
    const gradingWorkspace = join(workDir, 'grading');
    const patchedFixture = {
      ...fixture,
      grading: {
        ...fixture.grading,
        deterministic: [
          {
            id: 'crash',
            command: process.execPath,
            args: ['-e', 'process.exit(99)'],
          },
        ],
      },
    };
    const report = await runHiddenGrader({
      fixture: patchedFixture,
      fixtureRoot,
      gradingWorkspaceRoot: gradingWorkspace,
      candidatePatchPath: join(fixtureRoot, 'reference', 'solution.patch'),
      overlayIntegrity: 'unchanged',
      seedRepositoryPath: join(examplesRoot, 'seed-repo'),
      repositoryCommit,
    });
    expect(report.status).toBe('invalid_trial');
  });

  it('malformed-telemetry fault-injection yields unavailable metrics', () => {
    const telemetry = extractCursorTelemetry('not-json-at-all\n').telemetry;
    expect(telemetry.inputTokens.quality).toBe('unavailable');
    expect(telemetry.outputTokens.quality).toBe('unavailable');
    expect(telemetry.toolCalls.quality).toBe('unavailable');
  });

  it('grader-failure fault-injection maps exit 1 to incorrect', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'ael-qual-fail-'));
    const gradingWorkspace = join(workDir, 'grading');
    const patchedFixture = {
      ...fixture,
      grading: {
        ...fixture.grading,
        deterministic: [
          {
            id: 'reject',
            command: process.execPath,
            args: ['-e', 'process.exit(1)'],
            required: true,
          },
        ],
      },
    };
    const report = await runHiddenGrader({
      fixture: patchedFixture,
      fixtureRoot,
      gradingWorkspaceRoot: gradingWorkspace,
      candidatePatchPath: join(fixtureRoot, 'reference', 'solution.patch'),
      overlayIntegrity: 'unchanged',
      seedRepositoryPath: join(examplesRoot, 'seed-repo'),
      repositoryCommit,
    });
    expect(report.status).toBe('incorrect');
  });

  it('resume fault-injection rejects adapters without capabilities.resume at plan time', () => {
    const suiteRoot = mkdtempSync(join(tmpdir(), 'ael-qual-resume-suite-'));
    mkdirSync(join(suiteRoot, 'arms'), { recursive: true });
    mkdirSync(join(suiteRoot, 'fixtures/resume-me/prompts'), { recursive: true });
    mkdirSync(join(suiteRoot, 'fixtures/resume-me/grader'), { recursive: true });
    mkdirSync(join(suiteRoot, 'fixtures/resume-me/reference'), { recursive: true });
    mkdirSync(join(suiteRoot, 'seed'), { recursive: true });
    writeFileSync(join(suiteRoot, 'seed/README.md'), 'seed\n', 'utf8');
    writeFileSync(
      join(suiteRoot, 'arms/baseline.yaml'),
      'schemaVersion: 1\nid: baseline\nname: Baseline\nactions: []\n',
      'utf8',
    );
    writeFileSync(join(suiteRoot, 'fixtures/resume-me/prompts/initial.md'), 'start\n', 'utf8');
    writeFileSync(join(suiteRoot, 'fixtures/resume-me/prompts/recovery.md'), 'resume\n', 'utf8');
    writeFileSync(join(suiteRoot, 'fixtures/resume-me/grader/check.mjs'), 'process.exit(0);\n', 'utf8');
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
    const outputRoot = mkdtempSync(join(tmpdir(), 'ael-qual-resume-out-'));
    const stderr: string[] = [];
    const code = planCommand(join(suiteRoot, 'suite.yaml'), outputRoot, {
      stdout: () => {},
      stderr: (message) => {
        stderr.push(message);
      },
    });
    expect(code).toBe(EXIT_CAPABILITY);
    expect(stderr.join('')).toContain('capabilities.resume');
    expect(existsSync(join(outputRoot, 'trial-plan.json'))).toBe(false);
  });
});
