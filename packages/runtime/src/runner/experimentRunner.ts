import { join } from 'node:path';
import { z } from 'zod';

import type {
  AgentAdapter,
  ArmDocument,
  FixtureDocument,
  GradeStatus,
  IsolationProvider,
  Preregistration,
  SuiteDocument,
  TrialPlan,
  TrialStatus,
} from '@ael/core';
import { computeAttemptId, computeTrialId, fingerprintRecord } from '@ael/core';

import { readAtomicJson, writeAtomicJson } from '../artifacts/atomicWrite.js';
import { ExperimentLock } from '../artifacts/experimentLock.js';
import {
  pricingFingerprintForSuite,
  resolveSuitePricingPath,
  loadPricingSnapshot,
} from '../telemetry/pricing.js';
import {
  ConcurrencyLimiter,
  createCancellationToken,
  installSigintHandler,
} from './concurrency.js';
import { buildResumeFingerprints, evaluateResume, RUNNER_VERSION } from './resume.js';
import { runTrial } from './trialRunner.js';

const TrialStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    trialId: z.string(),
    attemptId: z.string(),
    status: z.string(),
    suiteFingerprint: z.string().optional(),
    agentFingerprint: z.string().optional(),
    isolationFingerprint: z.string().optional(),
    pricingFingerprint: z.string().optional(),
  })
  .passthrough();

export interface ExperimentRunnerInput {
  readonly experimentRoot: string;
  readonly suite: SuiteDocument;
  readonly suiteRoot: string;
  readonly suiteFingerprint: string;
  readonly trialPlan: TrialPlan;
  readonly preregistration: Preregistration;
  readonly fixtures: ReadonlyMap<string, { document: FixtureDocument; root: string }>;
  readonly arms: ReadonlyMap<string, { document: ArmDocument; path: string }>;
  readonly adapter: AgentAdapter;
  readonly isolation: IsolationProvider;
  readonly sourceRepositoryPath: string;
  readonly agentFingerprint: string;
  readonly isolationFingerprint: string;
  readonly pricingFingerprint: string;
  readonly maxInfraRetries?: number;
  readonly concurrency?: number;
}

export interface ExperimentRunnerResult {
  readonly completedTrials: number;
  readonly results: Array<{ trialId: string; status: TrialStatus; gradeStatus: GradeStatus }>;
  readonly configDrift: boolean;
  readonly cancelled: boolean;
}

export function fixtureRequiresResumeCapability(fixtures: Iterable<FixtureDocument>): boolean {
  for (const fixture of fixtures) {
    for (const phase of fixture.phases) {
      if (phase.session === 'resume') {
        return true;
      }
    }
  }
  return false;
}

export async function runExperiment(input: ExperimentRunnerInput): Promise<ExperimentRunnerResult> {
  const lock = new ExperimentLock(join(input.experimentRoot, 'lock.json'));
  await lock.acquire();

  const results: Array<{ trialId: string; status: TrialStatus; gradeStatus: GradeStatus }> = [];
  let completedTrials = 0;
  let configDrift = false;
  const maxInfraRetries = input.maxInfraRetries ?? 2;
  const concurrency = input.concurrency ?? input.suite.defaults.concurrency;
  const limiter = new ConcurrencyLimiter(Math.max(1, concurrency));
  const cancellation = createCancellationToken();
  const removeSigint = installSigintHandler(cancellation, () => undefined);

  const pricingPath = resolveSuitePricingPath(input.suiteRoot);
  const pricingSnapshot =
    pricingPath !== null ? loadPricingSnapshot(input.suiteRoot, pricingPath) : null;

  const currentFingerprints = buildResumeFingerprints({
    suiteFingerprint: input.suiteFingerprint,
    agentFingerprint: input.agentFingerprint,
    isolationFingerprint: input.isolationFingerprint,
    pricingFingerprint: input.pricingFingerprint,
  });

  try {
    for (const entry of input.trialPlan.trials) {
      if (cancellation.cancelled) {
        break;
      }

      const release = await limiter.acquire();
      try {
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
            if (infraFailureCount > maxInfraRetries) {
              configDrift = true;
              results.push({
                trialId,
                status: 'infrastructure_failed',
                gradeStatus: 'invalid_trial',
              });
              continue;
            }
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
          pricingSnapshot,
          cancellationToken: cancellation,
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
      } finally {
        release();
      }
    }
  } finally {
    removeSigint();
    await lock.release();
  }

  return {
    completedTrials,
    results,
    configDrift,
    cancelled: cancellation.cancelled,
  };
}

export { pricingFingerprintForSuite };
