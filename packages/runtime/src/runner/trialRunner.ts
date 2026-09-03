import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import type {
  AgentAdapter,
  ArmDocument,
  FixtureDocument,
  GradeReport,
  GradeStatus,
  IsolationProvider,
  SuiteDocument,
  TrialPlanEntry,
  TrialStatus,
} from '@ael/core';
import { computeAttemptId, computeTrialId, fingerprintRecord } from '@ael/core';

import { materializeArm } from '../arms/builtin.js';
import { AttemptStore } from '../artifacts/attempts.js';
import { readAtomicJson, writeAtomicJson } from '../artifacts/atomicWrite.js';
import { EventLog } from '../artifacts/eventLog.js';
import { ExperimentLock } from '../artifacts/experimentLock.js';
import { runHiddenGrader } from '../grading/hiddenGrader.js';
import { captureCandidateSnapshot } from '../workspace/candidateSnapshot.js';
import { seedWorkspace } from '../workspace/seedWorkspace.js';
import { isTerminalStatus, transitionTrialStatus } from './trialStateMachine.js';
import { buildResumeFingerprints, evaluateResume, RUNNER_VERSION } from './resume.js';

const TrialStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    trialId: z.string(),
    attemptId: z.string(),
    status: z.string(),
    workspaceRoot: z.string().optional(),
    baseFingerprint: z.string().optional(),
    planEntry: z.unknown().optional(),
  })
  .passthrough();

export interface TrialRunnerInput {
  readonly experimentRoot: string;
  readonly trialId: string;
  readonly attemptId: string;
  readonly suite: SuiteDocument;
  readonly suiteRoot: string;
  readonly fixture: FixtureDocument;
  readonly fixtureRoot: string;
  readonly arm: ArmDocument;
  readonly planEntry: TrialPlanEntry;
  readonly adapter: AgentAdapter;
  readonly isolation: IsolationProvider;
  readonly sourceRepositoryPath: string;
  readonly resumeFromStatus?: TrialStatus;
}

export interface TrialRunnerResult {
  readonly status: TrialStatus;
  readonly gradeStatus: GradeStatus;
  readonly gradeReport: GradeReport | null;
}

async function writeCheckpoint(
  eventLog: EventLog,
  experimentRoot: string,
  input: TrialRunnerInput,
  status: TrialStatus,
  checkpointSeq: number,
  extra: Record<string, unknown>,
): Promise<void> {
  const state = {
    schemaVersion: 1,
    trialId: input.trialId,
    attemptId: input.attemptId,
    status,
    planEntry: input.planEntry,
    ...extra,
  };
  const attemptDir = join(experimentRoot, 'attempts', input.trialId, input.attemptId);
  const store = new AttemptStore(experimentRoot);
  await store.createAttempt(input.trialId, input.attemptId, state).catch(() => undefined);
  await writeAtomicJson(join(attemptDir, 'state.json'), state);
  await eventLog.append({
    type: 'checkpoint',
    trialId: input.trialId,
    attemptId: input.attemptId,
    checkpointSeq,
    status,
  });
}

export async function runTrial(input: TrialRunnerInput): Promise<TrialRunnerResult> {
  const eventLog = new EventLog(join(input.experimentRoot, 'events.ndjson'));
  let status: TrialStatus = input.resumeFromStatus ?? 'pending';
  let checkpointSeq = 0;
  const attemptDir = join(input.experimentRoot, 'attempts', input.trialId, input.attemptId);
  const trialRoot = join(input.experimentRoot, 'trials', input.trialId, input.attemptId);

  const advance = async (
    event: Parameters<typeof transitionTrialStatus>[1],
    extra: Record<string, unknown> = {},
  ) => {
    const next = transitionTrialStatus(status, event);
    if (next === null) {
      throw new Error(`invalid transition ${status} -> ${event}`);
    }
    status = next;
    checkpointSeq += 1;
    await writeCheckpoint(eventLog, input.experimentRoot, input, status, checkpointSeq, extra);
  };

  let workspaceRoot = join(trialRoot, 'workspace');
  let baseFingerprint = '';

  if (status === 'pending') {
    await advance('start_preparing');
  }

  if (status === 'preparing') {
    const seeded = await seedWorkspace({
      sourceRepositoryPath: input.sourceRepositoryPath,
      commit: input.suite.repository.commit,
      trialRoot,
    });
    workspaceRoot = seeded.workspaceRoot;
    baseFingerprint = seeded.baseFingerprint;
    await materializeArm({
      workspaceRoot,
      trialId: input.trialId,
      arm: input.arm,
      suiteRoot: input.suiteRoot,
      overlayManifestPath: join(trialRoot, 'arm-materialization.json'),
    });
    await advance('prepared', { workspaceRoot, baseFingerprint });
  } else {
    try {
      const saved = await readAtomicJson(join(attemptDir, 'state.json'), TrialStateSchema);
      if (typeof saved.workspaceRoot === 'string') {
        workspaceRoot = saved.workspaceRoot;
      }
      if (typeof saved.baseFingerprint === 'string') {
        baseFingerprint = saved.baseFingerprint;
      }
    } catch {
      // use defaults
    }
  }

  if (status === 'running') {
    const session = await input.isolation.prepare({ workspaceRoot, trialId: input.trialId });
    const phase = input.fixture.phases[0];
    if (phase === undefined) {
      await advance('infrastructure_failed');
      return { status, gradeStatus: 'invalid_trial', gradeReport: null };
    }
    const promptSource = join(input.fixtureRoot, phase.promptFile);
    const promptTarget = join(workspaceRoot, '.ael', 'prompt.md');
    await mkdir(join(workspaceRoot, '.ael'), { recursive: true });
    await copyFile(promptSource, promptTarget);
    const invocation = await input.adapter.buildInvocation({
      workspaceRoot,
      promptFile: '.ael/prompt.md',
      phaseId: phase.id,
      sessionMode: phase.session,
    });
    const processResult = await input.isolation.run(session, invocation);
    await input.isolation.dispose(session);
    if (processResult.signal !== null) {
      await advance('timed_out', { workspaceRoot, baseFingerprint });
    } else if (processResult.exitCode !== 0) {
      await advance('agent_failed', { workspaceRoot, baseFingerprint });
    } else {
      await advance('agent_finished', { workspaceRoot, baseFingerprint });
    }
  }

  let gradeReport: GradeReport | null = null;

  if (status === 'collecting' || status === 'agent_failed' || status === 'timed_out') {
    const snapshot = await captureCandidateSnapshot({
      workspaceRoot,
      baseFingerprint,
      overlayManifestPath: join(trialRoot, 'arm-materialization.json'),
      artifactDir: join(attemptDir, 'artifacts'),
    });
    await writeAtomicJson(join(attemptDir, 'candidate-snapshot.json'), snapshot);
    await advance('collection_complete', { workspaceRoot, baseFingerprint });
    gradeReport = await runHiddenGrader({
      fixture: input.fixture,
      fixtureRoot: input.fixtureRoot,
      gradingWorkspaceRoot: join(trialRoot, 'grading-workspace'),
      candidatePatchPath: snapshot.patchArtifact,
      overlayIntegrity: snapshot.overlayIntegrity,
      seedRepositoryPath: input.sourceRepositoryPath,
      repositoryCommit: input.suite.repository.commit,
    });
    await writeAtomicJson(join(attemptDir, 'grade.json'), gradeReport);
    await advance('grading_complete', { workspaceRoot, baseFingerprint });
  } else if (status === 'grading') {
    const snapshotRaw = await readFile(join(attemptDir, 'candidate-snapshot.json'), 'utf8');
    const snapshot = JSON.parse(snapshotRaw) as {
      patchArtifact: string;
      overlayIntegrity: 'unchanged' | 'tampered';
    };
    gradeReport = await runHiddenGrader({
      fixture: input.fixture,
      fixtureRoot: input.fixtureRoot,
      gradingWorkspaceRoot: join(trialRoot, 'grading-workspace'),
      candidatePatchPath: snapshot.patchArtifact,
      overlayIntegrity: snapshot.overlayIntegrity,
      seedRepositoryPath: input.sourceRepositoryPath,
      repositoryCommit: input.suite.repository.commit,
    });
    await writeAtomicJson(join(attemptDir, 'grade.json'), gradeReport);
    await advance('grading_complete', { workspaceRoot, baseFingerprint });
  }

  if (!isTerminalStatus(status) && status !== 'completed') {
    return { status, gradeStatus: 'not_graded', gradeReport };
  }

  return {
    status: status === 'completed' ? status : status,
    gradeStatus: gradeReport?.status ?? 'not_graded',
    gradeReport,
  };
}

export interface ExperimentRunnerInput {
  readonly experimentRoot: string;
  readonly suite: SuiteDocument;
  readonly suiteRoot: string;
  readonly suiteFingerprint: string;
  readonly trialPlan: import('@ael/core').TrialPlan;
  readonly preregistration: import('@ael/core').Preregistration;
  readonly fixtures: ReadonlyMap<string, { document: FixtureDocument; root: string }>;
  readonly arms: ReadonlyMap<string, { document: ArmDocument; path: string }>;
  readonly adapter: AgentAdapter;
  readonly isolation: IsolationProvider;
  readonly sourceRepositoryPath: string;
  readonly agentFingerprint: string;
  readonly isolationFingerprint: string;
  readonly pricingFingerprint: string;
  readonly maxInfraRetries?: number;
}

export interface ExperimentRunnerResult {
  readonly completedTrials: number;
  readonly results: Array<{ trialId: string; status: TrialStatus; gradeStatus: GradeStatus }>;
  readonly configDrift: boolean;
}

export async function runExperiment(input: ExperimentRunnerInput): Promise<ExperimentRunnerResult> {
  const lock = new ExperimentLock(join(input.experimentRoot, 'lock.json'));
  await lock.acquire();

  const results: Array<{ trialId: string; status: TrialStatus; gradeStatus: GradeStatus }> = [];
  let completedTrials = 0;
  let configDrift = false;
  const maxInfraRetries = input.maxInfraRetries ?? 2;

  const currentFingerprints = buildResumeFingerprints({
    suiteFingerprint: input.suiteFingerprint,
    agentFingerprint: input.agentFingerprint,
    isolationFingerprint: input.isolationFingerprint,
    pricingFingerprint: input.pricingFingerprint,
  });

  try {
    for (const entry of input.trialPlan.trials) {
      const fixture = input.fixtures.get(entry.fixtureId);
      const arm = input.arms.get(entry.armId);
      if (fixture === undefined || arm === undefined) {
        continue;
      }

      const trialId = computeTrialId({
        experimentFingerprint: input.suiteFingerprint,
        suiteFingerprint: input.suiteFingerprint,
        fixtureFingerprint: fingerprintRecord('fixture', 1, fixture.document),
        armFingerprint: fingerprintRecord('arm', 1, arm.document),
        agentFingerprint: input.agentFingerprint,
        isolationFingerprint: input.isolationFingerprint,
        pricingFingerprint: input.pricingFingerprint,
        repeatIndex: entry.repeatIndex,
      });
      const attemptId = computeAttemptId({ trialId, attemptIndex: 0 });
      const attemptDir = join(input.experimentRoot, 'attempts', trialId, attemptId);

      let resumeFromStatus: TrialStatus | undefined;
      let attemptIndex = 0;
      let infraFailureCount = 0;
      try {
        const existing = await readAtomicJson(join(attemptDir, 'state.json'), TrialStateSchema);
        const storedFingerprints = buildResumeFingerprints({
          suiteFingerprint:
            typeof existing.suiteFingerprint === 'string'
              ? existing.suiteFingerprint
              : input.suiteFingerprint,
          agentFingerprint:
            typeof existing.agentFingerprint === 'string'
              ? existing.agentFingerprint
              : input.agentFingerprint,
          isolationFingerprint:
            typeof existing.isolationFingerprint === 'string'
              ? existing.isolationFingerprint
              : input.isolationFingerprint,
          pricingFingerprint:
            typeof existing.pricingFingerprint === 'string'
              ? existing.pricingFingerprint
              : input.pricingFingerprint,
        });
        const decision = evaluateResume({
          stored: storedFingerprints,
          current: currentFingerprints,
          attemptStatus: existing.status,
          attemptIndex: 0,
          maxInfraRetries,
          infraFailureCount,
        });
        if (decision.action === 'config_drift') {
          configDrift = true;
          results.push({
            trialId,
            status: 'infrastructure_failed',
            gradeStatus: 'invalid_trial',
          });
          continue;
        }
        if (decision.action === 'skip') {
          if (existing.status === 'completed') {
            completedTrials += 1;
            results.push({
              trialId,
              status: 'completed',
              gradeStatus: 'verified_success',
            });
          }
          continue;
        }
        if (decision.action === 'new_attempt') {
          attemptIndex = decision.attemptIndex;
        }
        if (existing.status === 'grading') {
          resumeFromStatus = 'grading';
        }
        if (existing.status === 'infrastructure_failed') {
          infraFailureCount += 1;
        }
      } catch {
        // fresh trial
      }

      const activeAttemptId = computeAttemptId({ trialId, attemptIndex });
      const activeAttemptDir = join(input.experimentRoot, 'attempts', trialId, activeAttemptId);

      const trialResult = await runTrial({
        experimentRoot: input.experimentRoot,
        trialId,
        attemptId: activeAttemptId,
        suite: input.suite,
        suiteRoot: input.suiteRoot,
        fixture: fixture.document,
        fixtureRoot: fixture.root,
        arm: arm.document,
        planEntry: entry,
        adapter: input.adapter,
        isolation: input.isolation,
        sourceRepositoryPath: input.sourceRepositoryPath,
        ...(resumeFromStatus !== undefined ? { resumeFromStatus } : {}),
      });

      await writeAtomicJson(join(activeAttemptDir, 'state.json'), {
        schemaVersion: 1,
        trialId,
        attemptId: activeAttemptId,
        status: trialResult.status,
        suiteFingerprint: input.suiteFingerprint,
        agentFingerprint: input.agentFingerprint,
        isolationFingerprint: input.isolationFingerprint,
        pricingFingerprint: input.pricingFingerprint,
        runnerVersion: RUNNER_VERSION,
      }).catch(() => undefined);

      if (trialResult.status === 'completed') {
        completedTrials += 1;
      }
      results.push({
        trialId,
        status: trialResult.status,
        gradeStatus: trialResult.gradeStatus,
      });
    }
  } finally {
    await lock.release();
  }

  return { completedTrials, results, configDrift };
}
