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
  PricingSnapshot,
  SuiteDocument,
  TrialPlanEntry,
  TrialStatus,
} from '@ael/core';

import { materializeArm } from '../arms/builtin.js';
import { AttemptStore } from '../artifacts/attempts.js';
import { readAtomicJson, writeAtomicJson } from '../artifacts/atomicWrite.js';
import { EventLog } from '../artifacts/eventLog.js';
import { runHiddenGrader } from '../grading/hiddenGrader.js';
import {
  aggregateTelemetryPhases,
  buildTrialTelemetryRecord,
  computeTelemetryCost,
} from '../telemetry/index.js';
import { captureCandidateSnapshot } from '../workspace/candidateSnapshot.js';
import { seedWorkspace } from '../workspace/seedWorkspace.js';
import { isTerminalStatus, transitionTrialStatus } from './trialStateMachine.js';

const TrialStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    trialId: z.string(),
    attemptId: z.string(),
    status: z.string(),
    workspaceRoot: z.string().optional(),
    baseFingerprint: z.string().optional(),
    planEntry: z.unknown().optional(),
    phaseIndex: z.number().int().nonnegative().optional(),
    sessionChatId: z.string().optional(),
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
  readonly model?: string;
  readonly pricingSnapshot?: PricingSnapshot | null;
  readonly cancellationToken?: { readonly cancelled: boolean };
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
  const logDir = join(attemptDir, 'logs');

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
  let phaseIndex = 0;
  let sessionChatId: string | undefined;
  const phaseTelemetry: import('@ael/core').AgentTelemetry[] = [];

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
    await advance('prepared', { workspaceRoot, baseFingerprint, phaseIndex });
  } else {
    try {
      const saved = await readAtomicJson(join(attemptDir, 'state.json'), TrialStateSchema);
      if (typeof saved.workspaceRoot === 'string') {
        workspaceRoot = saved.workspaceRoot;
      }
      if (typeof saved.baseFingerprint === 'string') {
        baseFingerprint = saved.baseFingerprint;
      }
      if (typeof saved.phaseIndex === 'number') {
        phaseIndex = saved.phaseIndex;
      }
      if (typeof saved.sessionChatId === 'string') {
        sessionChatId = saved.sessionChatId;
      }
    } catch {
      // use defaults
    }
  }

  if (status === 'running') {
    const session = await input.isolation.prepare({
      workspaceRoot,
      trialId: input.trialId,
      logDir,
    });
    let agentFailed = false;
    let timedOut = false;
    let lastStdoutPath = join(logDir, 'stdout.log');

    for (; phaseIndex < input.fixture.phases.length; phaseIndex += 1) {
      if (input.cancellationToken?.cancelled === true) {
        await input.isolation.dispose(session);
        await advance('cancelled', { workspaceRoot, baseFingerprint, phaseIndex });
        return { status, gradeStatus: 'not_graded', gradeReport: null };
      }

      const phase = input.fixture.phases[phaseIndex];
      if (phase === undefined) {
        break;
      }

      if (phase.session === 'resume' && input.adapter.capabilities?.resume !== true) {
        await input.isolation.dispose(session);
        await advance('infrastructure_failed', { workspaceRoot, baseFingerprint, phaseIndex });
        return { status, gradeStatus: 'invalid_trial', gradeReport: null };
      }

      const promptSource = join(input.fixtureRoot, phase.promptFile);
      const promptTarget = join(workspaceRoot, '.ael', `prompt-${phase.id}.md`);
      await mkdir(join(workspaceRoot, '.ael'), { recursive: true });
      await copyFile(promptSource, promptTarget);

      const invocation = await input.adapter.buildInvocation({
        workspaceRoot,
        promptFile: `.ael/prompt-${phase.id}.md`,
        phaseId: phase.id,
        sessionMode: phase.session,
        trialId: input.trialId,
        isolatedHomeRoot: join(workspaceRoot, '.ael', 'isolated-home', input.trialId),
        timeoutMs: input.fixture.limits.timeoutMsPerPhase,
        model: input.model ?? input.suite.agent.model,
        ...(phase.session === 'resume' && sessionChatId !== undefined
          ? { resumeChatId: sessionChatId }
          : {}),
      });

      const processResult = await input.isolation.run(session, invocation);
      const stdoutPath = processResult.stdoutPath ?? join(logDir, 'stdout.log');
      const stderrPath = processResult.stderrPath ?? join(logDir, 'stderr.log');
      lastStdoutPath = stdoutPath;
      const outcome = await input.adapter.parseOutcome({
        processResult,
        stdoutPath,
        stderrPath,
      });
      const telemetry = await input.adapter.collectTelemetry({
        stdoutPath,
        stderrPath,
        processResult,
      });
      phaseTelemetry.push(telemetry);

      if (outcome.sessionChatId !== undefined) {
        sessionChatId = outcome.sessionChatId;
      }

      await writeAtomicJson(join(attemptDir, `telemetry-phase-${phase.id}.json`), telemetry);

      if (processResult.signal !== null) {
        timedOut = true;
        break;
      }
      if (processResult.exitCode !== 0) {
        agentFailed = true;
        break;
      }
    }

    await input.isolation.dispose(session);

    const aggregated = aggregateTelemetryPhases(phaseTelemetry);
    const estimatedCostUsd =
      input.pricingSnapshot !== undefined && input.pricingSnapshot !== null
        ? computeTelemetryCost(
            aggregated,
            input.model ?? input.suite.agent.model,
            input.pricingSnapshot,
          )
        : {
            value: null,
            quality: 'unavailable' as const,
            source: 'pricing-snapshot',
            coverageReason: 'no pricing snapshot',
          };
    await writeAtomicJson(
      join(attemptDir, 'telemetry.json'),
      buildTrialTelemetryRecord({
        telemetry: aggregated,
        estimatedCostUsd,
        phaseCount: phaseTelemetry.length,
        rawArtifactPath: lastStdoutPath,
      }),
    );

    if (timedOut) {
      await advance('timed_out', { workspaceRoot, baseFingerprint, phaseIndex, sessionChatId });
    } else if (agentFailed) {
      await advance('agent_failed', { workspaceRoot, baseFingerprint, phaseIndex, sessionChatId });
    } else {
      await advance('agent_finished', {
        workspaceRoot,
        baseFingerprint,
        phaseIndex,
        sessionChatId,
      });
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
    await advance('collection_complete', {
      workspaceRoot,
      baseFingerprint,
      phaseIndex,
      sessionChatId,
    });
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
    await advance('grading_complete', {
      workspaceRoot,
      baseFingerprint,
      phaseIndex,
      sessionChatId,
    });
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
    await advance('grading_complete', {
      workspaceRoot,
      baseFingerprint,
      phaseIndex,
      sessionChatId,
    });
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
