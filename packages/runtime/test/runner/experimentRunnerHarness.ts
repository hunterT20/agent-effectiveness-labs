import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentAdapter,
  ArmDocument,
  FixtureDocument,
  GradeReport,
  GradeStatus,
  IsolationProvider,
  Preregistration,
  SuiteDocument,
  TrialPlan,
  TrialPlanEntry,
} from '@ael/core';
import { computeAttemptId, computeTrialId, fingerprintRecord } from '@ael/core';

import type { ExperimentRunnerInput } from '../../src/runner/experimentRunner.js';
import { RUNNER_VERSION } from '../../src/runner/resume.js';
import type { TrialRunnerInput, TrialRunnerResult } from '../../src/runner/trialRunner.js';

export const HARNESS_FINGERPRINTS = {
  suiteFingerprint: 'suite-fp',
  agentFingerprint: 'agent-fp',
  isolationFingerprint: 'iso-fp',
  pricingFingerprint: 'unpriced',
} as const;

export function buildFixture(id: string): FixtureDocument {
  return {
    schemaVersion: 1,
    id,
    name: id,
    category: 'bug-fix',
    outcomeMode: 'repository',
    phases: [{ id: 'initial', promptFile: './prompt.md', session: 'new' }],
    limits: { timeoutMsPerPhase: 1000, maxChangedFiles: 5 },
    candidate: { allowedPaths: ['src/**'], forbiddenPaths: [] },
    grading: {
      deterministic: [],
      blindedRubric: { enabled: false, rubricFile: null, minimumRaters: 0, minimumAgreement: null },
      llmJudge: { role: 'disabled' },
    },
    reference: {},
  };
}

export function buildArm(id: string): ArmDocument {
  return { schemaVersion: 1, id, name: id, actions: [] };
}

export function buildSuite(concurrency: number): SuiteDocument {
  return {
    schemaVersion: 1,
    id: 'harness-suite',
    name: 'harness suite',
    repository: {
      type: 'local-git',
      path: './seed-repo',
      commit: '0123456789abcdef0123456789abcdef01234567',
    },
    agent: { adapter: 'fake', model: 'fake-model', reasoning: 'standard', permissionMode: 'ro' },
    isolation: { provider: 'directory-only', require: {}, network: 'inherit' },
    defaults: {
      repeats: 1,
      concurrency,
      timeoutMs: 1000,
      randomSeed: 'harness-seed',
      cachePolicy: 'cold-isolated',
    },
    primaryControlArm: 'baseline',
    primaryTreatmentArm: 'treatment',
    arms: ['./arms/baseline.yaml', './arms/treatment.yaml'],
    fixtures: ['./fixtures/fx/fixture.yaml'],
    decisionPolicy: {
      mode: 'exploratory',
      minimumCompletedPairs: 1,
      minimumIndependentFixtures: 1,
      maximumInfrastructureFailureRate: 0.5,
      verifiedSuccessDeltaMin: 0,
      pairedImprovementPValueMax: 1,
      multipleComparisonMethod: 'none',
      treatmentCriticalSafetyMax: 0,
      treatmentStaleEvidenceAcceptedMax: 1,
      treatmentRecoveryRateMin: 0,
      treatmentFalseBlockRateMax: 1,
      telemetryCoverageMin: 0,
      treatmentToControlCostPerSuccessMaxRatio: 10,
      treatmentToControlMedianDurationMaxRatio: 10,
      treatmentToControlMedianTokensMaxRatio: 10,
    },
  };
}

export function buildGradeReport(status: GradeStatus): GradeReport {
  return {
    schemaVersion: 1,
    status,
    verified: status === 'verified_success',
    acceptancePassed: status === 'verified_success' ? 1 : 0,
    acceptanceTotal: 1,
    criticalFindings: 0,
    importantFindings: 0,
    safetyIncidents: 0,
    scopeViolation: false,
    testTampering: false,
    secretLeakage: false,
    staleEvidenceAccepted: null,
    recoveryRequired: false,
    recoveryPassed: null,
    safeActions: 0,
    falseBlocks: 0,
    checks: [],
  };
}

const unusedAdapter: AgentAdapter = {
  id: 'harness-adapter',
  contractVersion: 1,
  capabilities: { resume: false, streamJsonTelemetry: false, sandboxProbe: false },
  doctor: () => Promise.reject(new Error('adapter not used by harness')),
  buildInvocation: () => Promise.reject(new Error('adapter not used by harness')),
  parseOutcome: () => Promise.reject(new Error('adapter not used by harness')),
  collectTelemetry: () => Promise.reject(new Error('adapter not used by harness')),
};

const unusedIsolation: IsolationProvider = {
  doctor: () => Promise.reject(new Error('isolation not used by harness')),
  prepare: () => Promise.reject(new Error('isolation not used by harness')),
  run: () => Promise.reject(new Error('isolation not used by harness')),
  dispose: () => Promise.resolve(),
};

export interface SeedAttemptOptions {
  readonly status: string;
  /** Defaults to the harness fingerprints; pass `null` to omit provenance (legacy attempt). */
  readonly fingerprints?: Partial<Record<keyof typeof HARNESS_FINGERPRINTS, string>> | null;
  readonly runnerVersion?: string | null;
  readonly attemptIndexField?: boolean;
  readonly grade?: GradeStatus;
  readonly withProvenance?: boolean;
}

export interface ExperimentHarness {
  readonly experimentRoot: string;
  readonly input: ExperimentRunnerInput;
  readonly trialIds: readonly string[];
  attemptId(trialIndex: number, attemptIndex: number): string;
  attemptDir(trialIndex: number, attemptIndex: number): string;
  seedAttempt(trialIndex: number, attemptIndex: number, options: SeedAttemptOptions): void;
}

export interface HarnessOptions {
  readonly trialCount: number;
  readonly concurrency?: number;
  readonly maxInfraRetries?: number;
}

export function createExperimentHarness(options: HarnessOptions): ExperimentHarness {
  const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-experiment-runner-'));
  const suiteRoot = mkdtempSync(join(tmpdir(), 'ael-suite-root-'));
  const concurrency = options.concurrency ?? 1;
  const suite = buildSuite(concurrency);
  const fixture = buildFixture('fx');
  const arm = buildArm('baseline');

  const entries: TrialPlanEntry[] = [];
  for (let index = 0; index < options.trialCount; index += 1) {
    entries.push({
      trialIndex: index,
      blockIndex: index,
      fixtureId: fixture.id,
      armId: arm.id,
      repeatIndex: index,
    });
  }

  const trialPlan: TrialPlan = {
    schemaVersion: 1,
    randomSeed: 'harness-seed',
    prngVersion: 'mulberry32-v1',
    trials: entries,
    counts: {
      fixtures: 1,
      arms: 1,
      repeats: options.trialCount,
      blocks: options.trialCount,
      trials: options.trialCount,
      pairs: 0,
      independentFixtures: 1,
      agentInvocations: options.trialCount,
      timeoutExposureMs: options.trialCount * 1000,
    },
    comparisons: { primary: { controlArm: 'baseline', treatmentArm: 'treatment' }, secondary: [] },
    fingerprint: 'plan-fp',
  };

  const preregistration: Preregistration = {
    schemaVersion: 1,
    suiteFingerprint: HARNESS_FINGERPRINTS.suiteFingerprint,
    trialPlanFingerprint: 'plan-fp',
    sealedAt: '2026-01-01T00:00:00.000Z',
    randomSeed: 'harness-seed',
    primaryControlArm: 'baseline',
    primaryTreatmentArm: 'treatment',
    decisionPolicyMode: 'exploratory',
  };

  const trialIds = entries.map((entry) =>
    computeTrialId({
      experimentFingerprint: HARNESS_FINGERPRINTS.suiteFingerprint,
      suiteFingerprint: HARNESS_FINGERPRINTS.suiteFingerprint,
      fixtureFingerprint: fingerprintRecord('fixture', 1, fixture),
      armFingerprint: fingerprintRecord('arm', 1, arm),
      agentFingerprint: HARNESS_FINGERPRINTS.agentFingerprint,
      isolationFingerprint: HARNESS_FINGERPRINTS.isolationFingerprint,
      pricingFingerprint: HARNESS_FINGERPRINTS.pricingFingerprint,
      repeatIndex: entry.repeatIndex,
    }),
  );

  const trialIdAt = (trialIndex: number): string => {
    const trialId = trialIds[trialIndex];
    if (trialId === undefined) {
      throw new Error(`harness has no trial at index ${String(trialIndex)}`);
    }
    return trialId;
  };

  const attemptId = (trialIndex: number, attemptIndex: number): string =>
    computeAttemptId({ trialId: trialIdAt(trialIndex), attemptIndex });

  const attemptDir = (trialIndex: number, attemptIndex: number): string =>
    join(experimentRoot, 'attempts', trialIdAt(trialIndex), attemptId(trialIndex, attemptIndex));

  const seedAttempt = (
    trialIndex: number,
    attemptIndex: number,
    seed: SeedAttemptOptions,
  ): void => {
    const dir = attemptDir(trialIndex, attemptIndex);
    mkdirSync(dir, { recursive: true });
    const trialId = trialIdAt(trialIndex);
    const id = attemptId(trialIndex, attemptIndex);
    const fingerprints =
      seed.fingerprints === null ? null : { ...HARNESS_FINGERPRINTS, ...seed.fingerprints };
    const runnerVersion =
      seed.runnerVersion === null ? undefined : (seed.runnerVersion ?? RUNNER_VERSION);

    const state: Record<string, unknown> = {
      schemaVersion: 1,
      trialId,
      attemptId: id,
      status: seed.status,
      workspaceRoot: join(experimentRoot, 'trials', trialId, id, 'workspace'),
      phaseIndex: 1,
    };
    if (seed.attemptIndexField === true) {
      state['attemptIndex'] = attemptIndex;
    }
    if (fingerprints !== null) {
      Object.assign(state, {
        experimentFingerprint: fingerprints.suiteFingerprint,
        ...fingerprints,
      });
    }
    if (runnerVersion !== undefined) {
      state['runnerVersion'] = runnerVersion;
    }
    writeFileSync(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    if (seed.withProvenance === true && fingerprints !== null && runnerVersion !== undefined) {
      const provenance = {
        schemaVersion: 1,
        trialId,
        attemptId: id,
        attemptIndex,
        runnerVersion,
        experimentFingerprint: fingerprints.suiteFingerprint,
        ...fingerprints,
        startedAt: '2026-01-01T00:00:00.000Z',
      };
      writeFileSync(
        join(dir, 'provenance.json'),
        `${JSON.stringify(provenance, null, 2)}\n`,
        'utf8',
      );
    }

    if (seed.grade !== undefined) {
      writeFileSync(
        join(dir, 'grade.json'),
        `${JSON.stringify(buildGradeReport(seed.grade), null, 2)}\n`,
        'utf8',
      );
    }
  };

  const input: ExperimentRunnerInput = {
    experimentRoot,
    suite,
    suiteRoot,
    suiteFingerprint: HARNESS_FINGERPRINTS.suiteFingerprint,
    trialPlan,
    preregistration,
    fixtures: new Map([[fixture.id, { document: fixture, root: suiteRoot }]]),
    arms: new Map([[arm.id, { document: arm, path: join(suiteRoot, 'arm.yaml') }]]),
    adapter: unusedAdapter,
    isolation: unusedIsolation,
    sourceRepositoryPath: join(suiteRoot, 'seed-repo'),
    agentFingerprint: HARNESS_FINGERPRINTS.agentFingerprint,
    isolationFingerprint: HARNESS_FINGERPRINTS.isolationFingerprint,
    pricingFingerprint: HARNESS_FINGERPRINTS.pricingFingerprint,
    concurrency,
    ...(options.maxInfraRetries !== undefined ? { maxInfraRetries: options.maxInfraRetries } : {}),
  };

  return { experimentRoot, input, trialIds, attemptId, attemptDir, seedAttempt };
}

export interface FakeTrialRunner {
  readonly calls: TrialRunnerInput[];
  run(input: TrialRunnerInput): Promise<TrialRunnerResult>;
}

export function createFakeTrialRunner(
  behaviour: (input: TrialRunnerInput, callIndex: number) => Promise<TrialRunnerResult>,
): FakeTrialRunner {
  const calls: TrialRunnerInput[] = [];
  return {
    calls,
    run: (input) => {
      calls.push(input);
      return behaviour(input, calls.length - 1);
    },
  };
}

export function completedResult(gradeStatus: GradeStatus = 'verified_success'): TrialRunnerResult {
  return { status: 'completed', gradeStatus, gradeReport: buildGradeReport(gradeStatus) };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createDeferred(): { readonly promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
