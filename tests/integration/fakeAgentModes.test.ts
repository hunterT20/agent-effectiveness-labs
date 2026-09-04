import { cpSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { describe, expect, it } from 'vitest';

import {
  buildTrialPlan,
  computeAttemptId,
  computeFingerprint,
  fingerprintRecord,
  loadSuiteManifest,
  parseArmDocument,
  parseFixtureDocument,
  sealPreregistration,
  type ArmDocument,
  type FixtureDocument,
  type GradeStatus,
  type TrialStatus,
} from '@ael/core';
import {
  createCustomCommandAdapter,
  DirectoryOnlyIsolationProvider,
  FAKE_AGENT_ADAPTER_ID,
  pricingFingerprintForSuite,
  runExperiment,
} from '@ael/runtime';

import { createTempSeedRepo } from '../../packages/runtime/test/helpers/tempSeedRepo.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureSource = join(repoRoot, 'tests/fixtures/fake-modes');
const fakeAgentPath = join(repoRoot, 'tests/fake-agent/fake-agent.mjs');

const MODES = [
  'success',
  'incorrect',
  'timeout',
  'child-survivor',
  'claims-done',
  'nonzero-correct',
  'untracked',
  'binary',
  'overlay-tamper',
  'scope-escape',
  'secret-leak',
  'malformed-telemetry',
] as const;

const EXPECTED: Record<(typeof MODES)[number], { status: TrialStatus; grade: GradeStatus }> = {
  success: { status: 'completed', grade: 'verified_success' },
  incorrect: { status: 'completed', grade: 'incorrect' },
  timeout: { status: 'timed_out', grade: 'incorrect' },
  'child-survivor': { status: 'completed', grade: 'verified_success' },
  'claims-done': { status: 'completed', grade: 'incorrect' },
  'nonzero-correct': { status: 'agent_failed', grade: 'verified_success' },
  untracked: { status: 'completed', grade: 'incorrect' },
  binary: { status: 'completed', grade: 'verified_success' },
  'overlay-tamper': { status: 'completed', grade: 'invalid_trial' },
  'scope-escape': { status: 'completed', grade: 'incorrect' },
  'secret-leak': { status: 'completed', grade: 'verified_success' },
  'malformed-telemetry': { status: 'completed', grade: 'verified_success' },
};

describe('fake agent modes', () => {
  it('runs all 12 modes through runExperiment and proves arms differ', async () => {
    const suiteRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ael-fake-modes-')));
    cpSync(fixtureSource, suiteRoot, { recursive: true });
    const seed = await createTempSeedRepo({ directory: join(suiteRoot, 'seed-repo') });
    const suitePath = join(suiteRoot, 'suite.yaml');
    writeFileSync(
      suitePath,
      readFileSync(suitePath, 'utf8').replace('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', seed.commit),
      'utf8',
    );

    const sharedGrader = join(suiteRoot, 'shared', 'grader');
    const sharedReference = join(suiteRoot, 'shared', 'reference');
    for (const mode of MODES) {
      cpSync(sharedGrader, join(suiteRoot, 'fixtures', mode, 'grader'), { recursive: true });
      cpSync(sharedReference, join(suiteRoot, 'fixtures', mode, 'reference'), { recursive: true });
    }

    const loaded = loadSuiteManifest(suitePath);
    const suite = loaded.normalizedValue;
    const fixtures = new Map<string, { document: FixtureDocument; root: string }>();
    for (const fixturePath of suite.fixtures) {
      const sourcePath = join(loaded.manifestDir, fixturePath);
      const document = parseFixtureDocument(parseYaml(readFileSync(sourcePath, 'utf8')), sourcePath);
      fixtures.set(document.id, { document, root: dirname(sourcePath) });
    }
    const arms = new Map<string, { document: ArmDocument; path: string }>();
    for (const armPath of suite.arms) {
      const sourcePath = join(loaded.manifestDir, armPath);
      const document = parseArmDocument(parseYaml(readFileSync(sourcePath, 'utf8')), sourcePath);
      arms.set(document.id, { document, path: sourcePath });
    }

    const fixtureIds = [...fixtures.keys()];
    const armIds = [...arms.keys()];
    const trialPlan = buildTrialPlan({
      fixtureIds,
      armIds,
      repeats: suite.defaults.repeats,
      randomSeed: suite.defaults.randomSeed,
      primaryControlArm: suite.primaryControlArm,
      primaryTreatmentArm: suite.primaryTreatmentArm,
      timeoutMs: suite.defaults.timeoutMs,
      phasesPerFixture: 1,
    });
    const suiteFingerprint = fingerprintRecord('suite', 1, suite);
    const preregistration = sealPreregistration({
      suiteFingerprint,
      trialPlan,
      primaryControlArm: suite.primaryControlArm,
      primaryTreatmentArm: suite.primaryTreatmentArm,
      decisionPolicyMode: suite.decisionPolicy.mode,
    });

    const adapter = createCustomCommandAdapter(FAKE_AGENT_ADAPTER_ID, {
      command: process.execPath,
      extraArgs: [fakeAgentPath],
      timeoutMs: suite.defaults.timeoutMs,
    });
    expect(adapter.capabilities?.resume).toBe(true);

    const experimentRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ael-fake-modes-out-')));
    const experiment = await runExperiment({
      experimentRoot,
      suite,
      suiteRoot: loaded.manifestDir,
      suiteFingerprint,
      trialPlan,
      preregistration,
      fixtures,
      arms,
      adapter,
      isolation: new DirectoryOnlyIsolationProvider(),
      sourceRepositoryPath: seed.repoPath,
      agentFingerprint: computeFingerprint(suite.agent),
      isolationFingerprint: computeFingerprint(suite.isolation),
      pricingFingerprint: pricingFingerprintForSuite(loaded.manifestDir),
      concurrency: 1,
    });

    expect(experiment.results).toHaveLength(trialPlan.trials.length);
    expect(experiment.results.length).toBe(24);

    const mismatches: Array<Record<string, unknown>> = [];
    for (const [index, entry] of trialPlan.trials.entries()) {
      const trial = experiment.results[index];
      const expected = EXPECTED[entry.fixtureId as (typeof MODES)[number]];
      if (trial?.status !== expected.status || trial.gradeStatus !== expected.grade) {
        const attemptId = computeAttemptId({ trialId: trial?.trialId ?? '', attemptIndex: 0 });
        let stdout = '';
        try {
          stdout = readFileSync(
            join(experimentRoot, 'attempts', trial?.trialId ?? '', attemptId, 'logs', 'stdout.log'),
            'utf8',
          );
        } catch {
          stdout = '(missing stdout)';
        }
        mismatches.push({
          fixtureId: entry.fixtureId,
          armId: entry.armId,
          expected,
          actual: { status: trial?.status, gradeStatus: trial?.gradeStatus },
          stdout: stdout.slice(0, 500),
        });
      }
    }
    expect(mismatches).toEqual([]);

    const successTrials = trialPlan.trials
      .map((entry, index) => ({ entry, trial: experiment.results[index] }))
      .filter((item) => item.entry.fixtureId === 'success');
    expect(successTrials).toHaveLength(2);
    const markers = successTrials.map(({ trial }) => {
      if (trial === undefined) {
        throw new Error('missing success trial');
      }
      const attemptId = computeAttemptId({ trialId: trial.trialId, attemptIndex: 0 });
      const stdout = readFileSync(
        join(experimentRoot, 'attempts', trial.trialId, attemptId, 'logs', 'stdout.log'),
        'utf8',
      );
      const materialization = JSON.parse(
        readFileSync(
          join(experimentRoot, 'trials', trial.trialId, attemptId, 'arm-materialization.json'),
          'utf8',
        ),
      ) as { environment: Record<string, string> };
      const logged = /AEL_ARM_MARKER=(\S+)/.exec(stdout)?.[1];
      expect(logged).toBe(materialization.environment.AEL_ARM_MARKER);
      return logged;
    });
    expect(new Set(markers)).toEqual(new Set(['baseline', 'treatment']));

    const untrackedEntry = trialPlan.trials.find((entry) => entry.fixtureId === 'untracked');
    expect(untrackedEntry).toBeDefined();
    const untrackedIndex = trialPlan.trials.findIndex((entry) => entry.fixtureId === 'untracked');
    const untrackedResult = experiment.results[untrackedIndex];
    expect(untrackedResult).toBeDefined();
    const untrackedAttempt = computeAttemptId({
      trialId: untrackedResult?.trialId ?? '',
      attemptIndex: 0,
    });
    const grade = JSON.parse(
      readFileSync(
        join(
          experimentRoot,
          'attempts',
          untrackedResult?.trialId ?? '',
          untrackedAttempt,
          'grade.json',
        ),
        'utf8',
      ),
    ) as { scopeViolation: boolean };
    expect(grade.scopeViolation).toBe(true);
  }, 180_000);
});
