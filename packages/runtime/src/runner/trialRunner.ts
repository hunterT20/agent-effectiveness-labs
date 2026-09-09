import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import type {
  AgentAdapter,
  AgentTelemetry,
  ArmDocument,
  ArmMaterialization,
  FixtureDocument,
  GradeReport,
  GradeStatus,
  IsolationProvider,
  IsolationSession,
  PricingSnapshot,
  SuiteDocument,
  TrialPlanEntry,
  TrialStatus,
} from '@ael/core';
import { ArmMaterializationSchema, TrialStatusSchema } from '@ael/core';

import { materializeArm } from '../arms/builtin.js';
import { AttemptStore } from '../artifacts/attempts.js';
import { readAtomicJson, writeAtomicJson } from '../artifacts/atomicWrite.js';
import type { ProtectedBlobStore } from '../artifacts/encryption.js';
import { EventLog } from '../artifacts/eventLog.js';
import { runHiddenGrader } from '../grading/hiddenGrader.js';
import {
  aggregateTelemetryPhases,
  buildTrialTelemetryRecord,
  computeTelemetryCost,
} from '../telemetry/index.js';
import {
  captureCandidateSnapshot,
  PublicCandidateSnapshotSchema,
  type PublicCandidateSnapshot,
} from '../workspace/candidateSnapshot.js';
import { seedWorkspace } from '../workspace/seedWorkspace.js';
import type { CancellationToken } from './concurrency.js';
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
    armMaterialization: ArmMaterializationSchema.optional(),
    /** Agent-phase outcome preserved across grading (`agent_failed` / `timed_out`). */
    agentOutcomeStatus: TrialStatusSchema.optional(),
    failureReason: z.string().optional(),
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
  readonly cancellationToken?: CancellationToken;
  /** When present, candidate patch and untracked archive are persisted only as protected blobs. */
  readonly protectedBlobStore?: ProtectedBlobStore;
}

export interface TrialRunnerResult {
  /**
   * Reported trial status. When the agent phase ended in `agent_failed` or `timed_out` the
   * candidate is still graded, but that agent outcome is what is reported here.
   */
  readonly status: TrialStatus;
  readonly gradeStatus: GradeStatus;
  readonly gradeReport: GradeReport | null;
  readonly failureReason: string | null;
}

interface TrialPaths {
  readonly attemptDir: string;
  readonly trialRoot: string;
  readonly logDir: string;
  readonly promptDir: string;
  readonly isolatedHomeRoot: string;
  readonly armMaterializationPath: string;
  readonly artifactDir: string;
  readonly gradingWorkspaceRoot: string;
}

function resolveTrialPaths(input: TrialRunnerInput): TrialPaths {
  const attemptDir = join(input.experimentRoot, 'attempts', input.trialId, input.attemptId);
  const trialRoot = join(input.experimentRoot, 'trials', input.trialId, input.attemptId);
  return {
    attemptDir,
    trialRoot,
    logDir: join(attemptDir, 'logs'),
    promptDir: join(trialRoot, 'prompts'),
    isolatedHomeRoot: join(trialRoot, 'isolated-home'),
    armMaterializationPath: join(trialRoot, 'arm-materialization.json'),
    artifactDir: join(attemptDir, 'artifacts'),
    gradingWorkspaceRoot: join(trialRoot, 'grading-workspace'),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function unavailableCost(reason: string) {
  return {
    value: null,
    quality: 'unavailable' as const,
    source: 'pricing-snapshot',
    coverageReason: reason,
  };
}

export async function runTrial(input: TrialRunnerInput): Promise<TrialRunnerResult> {
  const paths = resolveTrialPaths(input);
  const eventLog = new EventLog(join(input.experimentRoot, 'events.ndjson'));
  let status: TrialStatus = input.resumeFromStatus ?? 'pending';
  let checkpointSeq = 0;

  let workspaceRoot = join(paths.trialRoot, 'workspace');
  let baseFingerprint = '';
  let phaseIndex = 0;
  let sessionChatId: string | undefined;
  let armMaterialization: ArmMaterialization | undefined;
  let agentOutcomeStatus: TrialStatus | undefined;
  let failureReason: string | null = null;
  let session: IsolationSession | undefined;
  const phaseTelemetry: AgentTelemetry[] = [];

  const checkpointExtra = (): Record<string, unknown> => ({
    workspaceRoot,
    baseFingerprint,
    phaseIndex,
    ...(sessionChatId !== undefined ? { sessionChatId } : {}),
    ...(armMaterialization !== undefined ? { armMaterialization } : {}),
    ...(agentOutcomeStatus !== undefined ? { agentOutcomeStatus } : {}),
    ...(failureReason !== null ? { failureReason } : {}),
  });

  const advance = async (event: Parameters<typeof transitionTrialStatus>[1]) => {
    const next = transitionTrialStatus(status, event);
    if (next === null) {
      throw new Error(`invalid transition ${status} -> ${event}`);
    }
    status = next;
    checkpointSeq += 1;
    await writeCheckpoint(
      eventLog,
      input.experimentRoot,
      input,
      status,
      checkpointSeq,
      checkpointExtra(),
    );
  };

  const disposeSession = async (): Promise<void> => {
    if (session !== undefined) {
      const active = session;
      session = undefined;
      await input.isolation.dispose(active).catch(() => undefined);
    }
  };

  const failInfrastructure = async (reason: string): Promise<TrialRunnerResult> => {
    failureReason = reason;
    await disposeSession();
    if (transitionTrialStatus(status, 'infrastructure_failed') !== null) {
      await advance('infrastructure_failed').catch(() => undefined);
    }
    return { status, gradeStatus: 'invalid_trial', gradeReport: null, failureReason };
  };

  const reportedStatus = (): TrialStatus => agentOutcomeStatus ?? status;

  try {
    if (status === 'pending') {
      await advance('start_preparing');
    }

    if (status === 'preparing') {
      try {
        const seeded = await seedWorkspace({
          sourceRepositoryPath: input.sourceRepositoryPath,
          commit: input.suite.repository.commit,
          trialRoot: paths.trialRoot,
        });
        workspaceRoot = seeded.workspaceRoot;
        baseFingerprint = seeded.baseFingerprint;
        await mkdir(paths.isolatedHomeRoot, { recursive: true });
        session = await input.isolation.prepare({
          workspaceRoot,
          trialId: input.trialId,
          logDir: paths.logDir,
        });
        armMaterialization = await materializeArm({
          workspaceRoot,
          trialId: input.trialId,
          arm: input.arm,
          suiteRoot: input.suiteRoot,
          overlayManifestPath: paths.armMaterializationPath,
          isolation: input.isolation,
          isolationSession: session,
          isolatedHomeRoot: paths.isolatedHomeRoot,
        });
      } catch (error) {
        return await failInfrastructure(`preparation failed: ${errorMessage(error)}`);
      }
      await advance('prepared');
    } else {
      try {
        const saved = await readAtomicJson(join(paths.attemptDir, 'state.json'), TrialStateSchema);
        if (saved.workspaceRoot !== undefined) {
          workspaceRoot = saved.workspaceRoot;
        }
        if (saved.baseFingerprint !== undefined) {
          baseFingerprint = saved.baseFingerprint;
        }
        if (saved.phaseIndex !== undefined) {
          phaseIndex = saved.phaseIndex;
        }
        sessionChatId = saved.sessionChatId;
        armMaterialization = saved.armMaterialization;
        agentOutcomeStatus = saved.agentOutcomeStatus;
      } catch {
        // use defaults
      }
    }

    if (status === 'running') {
      try {
        session ??= await input.isolation.prepare({
          workspaceRoot,
          trialId: input.trialId,
          logDir: paths.logDir,
        });
        let agentFailed = false;
        let timedOut = false;
        let lastStdoutPath = join(paths.logDir, 'stdout.log');
        await mkdir(paths.promptDir, { recursive: true });

        for (; phaseIndex < input.fixture.phases.length; phaseIndex += 1) {
          if (input.cancellationToken?.cancelled === true) {
            await disposeSession();
            await advance('cancelled');
            return { status, gradeStatus: 'not_graded', gradeReport: null, failureReason: null };
          }

          const phase = input.fixture.phases[phaseIndex];
          if (phase === undefined) {
            break;
          }

          if (phase.session === 'resume' && input.adapter.capabilities?.resume !== true) {
            return await failInfrastructure(
              `phase ${phase.id} requires session resume but adapter lacks capabilities.resume`,
            );
          }

          // Prompts live under the trial root, outside the agent workspace, so they never leak
          // into the candidate snapshot. Adapters that join the prompt onto the workspace root still
          // accept an absolute path.
          const promptSource = join(input.fixtureRoot, phase.promptFile);
          const promptTarget = join(paths.promptDir, `prompt-${phase.id}.md`);
          await copyFile(promptSource, promptTarget);
          const promptFile = promptTarget;

          const invocation = await input.adapter.buildInvocation({
            workspaceRoot,
            promptFile,
            phaseId: phase.id,
            sessionMode: phase.session,
            trialId: input.trialId,
            isolatedHomeRoot: paths.isolatedHomeRoot,
            timeoutMs: input.fixture.limits.timeoutMsPerPhase,
            model: input.model ?? input.suite.agent.model,
            environment: armMaterialization?.environment ?? {},
            argvAdditions: armMaterialization?.argvAdditions ?? [],
            pluginDirs: armMaterialization?.pluginDirs ?? [],
            ...(phase.session === 'resume' && sessionChatId !== undefined
              ? { resumeChatId: sessionChatId }
              : {}),
          });

          const processResult = await input.isolation.run(session, {
            ...invocation,
            ...(input.cancellationToken !== undefined
              ? { abortSignal: input.cancellationToken.signal }
              : {}),
          });
          const stdoutPath = processResult.stdoutPath ?? join(paths.logDir, 'stdout.log');
          const stderrPath = processResult.stderrPath ?? join(paths.logDir, 'stderr.log');
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

          await writeAtomicJson(
            join(paths.attemptDir, `telemetry-phase-${phase.id}.json`),
            telemetry,
          );

          if (processResult.signal !== null || processResult.exitCode === null) {
            timedOut = true;
            break;
          }
          if (processResult.exitCode !== 0) {
            agentFailed = true;
            break;
          }
        }

        await disposeSession();

        const aggregated = aggregateTelemetryPhases(phaseTelemetry);
        const estimatedCostUsd =
          input.pricingSnapshot !== undefined && input.pricingSnapshot !== null
            ? computeTelemetryCost(
                aggregated,
                input.model ?? input.suite.agent.model,
                input.pricingSnapshot,
              )
            : unavailableCost('no pricing snapshot');
        await writeAtomicJson(
          join(paths.attemptDir, 'telemetry.json'),
          buildTrialTelemetryRecord({
            telemetry: aggregated,
            estimatedCostUsd,
            phaseCount: phaseTelemetry.length,
            rawArtifactPath: lastStdoutPath,
          }),
        );

        if (timedOut) {
          agentOutcomeStatus = 'timed_out';
          await advance('timed_out');
        } else if (agentFailed) {
          agentOutcomeStatus = 'agent_failed';
          await advance('agent_failed');
        } else {
          await advance('agent_finished');
        }
      } catch (error) {
        return await failInfrastructure(`agent phase failed: ${errorMessage(error)}`);
      }
    }

    let gradeReport: GradeReport | null = null;

    const grade = async (snapshot: PublicCandidateSnapshot): Promise<GradeReport> => {
      const report = await runHiddenGrader({
        fixture: input.fixture,
        fixtureRoot: input.fixtureRoot,
        gradingWorkspaceRoot: paths.gradingWorkspaceRoot,
        candidatePatchPath: snapshot.patchArtifact,
        overlayIntegrity: snapshot.overlayIntegrity,
        seedRepositoryPath: input.sourceRepositoryPath,
        repositoryCommit: input.suite.repository.commit,
        untrackedArchivePath: snapshot.untrackedArchiveArtifact,
        ...(input.protectedBlobStore !== undefined
          ? { protectedBlobStore: input.protectedBlobStore }
          : {}),
        protectedPatchRef: snapshot.protectedPatchRef,
        protectedUntrackedRef: snapshot.protectedUntrackedRef,
        scope: snapshot.scope,
        candidateInvalidReason: snapshot.candidateInvalidReason,
      });
      await writeAtomicJson(join(paths.attemptDir, 'grade.json'), report);
      await advance('grading_complete');
      return report;
    };

    if (status === 'collecting' || status === 'agent_failed' || status === 'timed_out') {
      try {
        const snapshot = await captureCandidateSnapshot({
          workspaceRoot,
          baseFingerprint,
          overlayManifestPath: paths.armMaterializationPath,
          artifactDir: paths.artifactDir,
          ...(input.protectedBlobStore !== undefined
            ? { protectedBlobStore: input.protectedBlobStore }
            : {}),
          scopePolicy: {
            allowedPaths: input.fixture.candidate.allowedPaths,
            forbiddenPaths: input.fixture.candidate.forbiddenPaths,
            maxChangedFiles: input.fixture.limits.maxChangedFiles,
          },
        });
        await writeAtomicJson(join(paths.attemptDir, 'candidate-snapshot.json'), snapshot);
        await advance('collection_complete');
        gradeReport = await grade(snapshot);
      } catch (error) {
        return await failInfrastructure(`collection or grading failed: ${errorMessage(error)}`);
      }
    } else if (status === 'grading') {
      try {
        const snapshot = await readAtomicJson(
          join(paths.attemptDir, 'candidate-snapshot.json'),
          PublicCandidateSnapshotSchema,
        );
        gradeReport = await grade(snapshot);
      } catch (error) {
        return await failInfrastructure(`grading failed: ${errorMessage(error)}`);
      }
    }

    if (!isTerminalStatus(status) && status !== 'completed') {
      return { status: reportedStatus(), gradeStatus: 'not_graded', gradeReport, failureReason };
    }

    return {
      status: reportedStatus(),
      gradeStatus: gradeReport === null ? 'not_graded' : gradeReport.status,
      gradeReport,
      failureReason,
    };
  } catch (error) {
    return failInfrastructure(`trial failed: ${errorMessage(error)}`);
  }
}
