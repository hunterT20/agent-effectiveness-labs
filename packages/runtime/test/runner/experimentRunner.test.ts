import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AttemptProvenanceSchema, AttemptStateSchema } from '../../src/artifacts/schemas.js';
import {
  fixtureRequiresResumeCapability,
  RUN_SUMMARY_FILENAME,
  runExperiment,
} from '../../src/runner/experimentRunner.js';
import { RESUME_ERROR_CODES, RUNNER_VERSION } from '../../src/runner/resume.js';
import {
  buildFixture,
  completedResult,
  createDeferred,
  createExperimentHarness,
  createFakeTrialRunner,
  sleep,
} from './experimentRunnerHarness.js';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('experiment runner helpers', () => {
  it('detects fixtures that require resume capability', () => {
    const fixture = buildFixture('multi');
    const requires = fixtureRequiresResumeCapability([
      {
        ...fixture,
        phases: [
          { id: 'initial', promptFile: './a.md', session: 'new' },
          { id: 'recovery', promptFile: './b.md', session: 'resume' },
        ],
      },
    ]);
    expect(requires).toBe(true);
    expect(fixtureRequiresResumeCapability([fixture])).toBe(false);
  });
});

describe('runExperiment', () => {
  it('runs fresh trials in plan order and persists provenance, state, and run-summary', async () => {
    const harness = createExperimentHarness({ trialCount: 3 });
    const runner = createFakeTrialRunner(() => Promise.resolve(completedResult()));

    const result = await runExperiment({ ...harness.input, trialRunner: runner.run });

    expect(result.results.map((entry) => entry.trialId)).toEqual(harness.trialIds);
    expect(result.results.every((entry) => entry.resumeAction === 'fresh')).toBe(true);
    expect(result.completedTrials).toBe(3);
    expect(result.configDrift).toBe(false);
    expect(result.exhaustedTrials).toEqual([]);
    expect(result.cancelled).toBe(false);
    expect(result.cancellation).toEqual({ cancelled: false, unscheduledTrials: 0 });
    expect(result.runnerVersion).toBe(RUNNER_VERSION);
    expect(runner.calls.map((call) => call.trialId)).toEqual(harness.trialIds);
    expect(runner.calls[0]?.attemptId).toBe(harness.attemptId(0, 0));

    const provenance = AttemptProvenanceSchema.parse(
      readJson(join(harness.attemptDir(0, 0), 'provenance.json')),
    );
    expect(provenance.attemptIndex).toBe(0);
    expect(provenance.runnerVersion).toBe(RUNNER_VERSION);
    expect(provenance.agentFingerprint).toBe('agent-fp');

    const state = AttemptStateSchema.parse(readJson(join(harness.attemptDir(0, 0), 'state.json')));
    expect(state.status).toBe('completed');
    expect(state.attemptIndex).toBe(0);
    expect(state.runnerVersion).toBe(RUNNER_VERSION);
    expect(state.suiteFingerprint).toBe('suite-fp');

    expect(result.summaryPath).toBe(join(harness.experimentRoot, RUN_SUMMARY_FILENAME));
    const summary = readJson(result.summaryPath);
    expect(summary).toMatchObject({
      schemaVersion: 1,
      runnerVersion: RUNNER_VERSION,
      cancelled: false,
      plannedTrials: 3,
      reportedTrials: 3,
      completedTrials: 3,
      statusCounts: { completed: 3 },
      gradeStatusCounts: { verified_success: 3 },
      resumeActionCounts: { fresh: 3 },
      driftedTrials: [],
      exhaustedTrials: [],
    });
    expect(existsSync(join(harness.experimentRoot, 'lock.json'))).toBe(false);
  });

  it('preserves trial runner checkpoint fields when merging provenance into state.json', async () => {
    const harness = createExperimentHarness({ trialCount: 1 });
    const runner = createFakeTrialRunner(async (input) => {
      const { writeAtomicJson } = await import('../../src/artifacts/atomicWrite.js');
      await writeAtomicJson(
        join(input.experimentRoot, 'attempts', input.trialId, input.attemptId, 'state.json'),
        {
          schemaVersion: 1,
          trialId: input.trialId,
          attemptId: input.attemptId,
          status: 'grading',
          workspaceRoot: '/tmp/ws',
          phaseIndex: 1,
        },
      );
      return completedResult();
    });

    await runExperiment({ ...harness.input, trialRunner: runner.run });

    const state = AttemptStateSchema.parse(readJson(join(harness.attemptDir(0, 0), 'state.json')));
    expect(state.status).toBe('completed');
    expect(state['workspaceRoot']).toBe('/tmp/ws');
    expect(state['phaseIndex']).toBe(1);
    expect(state.attemptIndex).toBe(0);
  });

  it('skips completed trials and reports the stored grade status', async () => {
    const harness = createExperimentHarness({ trialCount: 2 });
    harness.seedAttempt(0, 0, { status: 'completed', grade: 'incorrect', withProvenance: true });
    const runner = createFakeTrialRunner(() => Promise.resolve(completedResult()));

    const result = await runExperiment({ ...harness.input, trialRunner: runner.run });

    expect(runner.calls.map((call) => call.trialId)).toEqual([harness.trialIds[1]]);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      trialId: harness.trialIds[0],
      attemptIndex: 0,
      status: 'completed',
      gradeStatus: 'incorrect',
      resumeAction: 'skip',
    });
    expect(result.results[1]).toMatchObject({ status: 'completed', resumeAction: 'fresh' });
    expect(result.completedTrials).toBe(2);
  });

  it('reports not_graded for a completed attempt without grade.json', async () => {
    const harness = createExperimentHarness({ trialCount: 1 });
    harness.seedAttempt(0, 0, { status: 'completed' });
    const runner = createFakeTrialRunner(() => Promise.resolve(completedResult()));

    const result = await runExperiment({ ...harness.input, trialRunner: runner.run });

    expect(runner.calls).toHaveLength(0);
    expect(result.results[0]).toMatchObject({ status: 'completed', gradeStatus: 'not_graded' });
  });

  it('resumes a collecting attempt from its checkpoint without a new attempt', async () => {
    const harness = createExperimentHarness({ trialCount: 1 });
    harness.seedAttempt(0, 0, { status: 'collecting', withProvenance: true });
    const runner = createFakeTrialRunner(() => Promise.resolve(completedResult()));

    const result = await runExperiment({ ...harness.input, trialRunner: runner.run });

    expect(runner.calls[0]).toMatchObject({
      attemptId: harness.attemptId(0, 0),
      resumeFromStatus: 'collecting',
    });
    expect(result.results[0]).toMatchObject({ attemptIndex: 0, resumeAction: 'resume' });
  });

  it('starts a new attempt for an abandoned preparing attempt', async () => {
    const harness = createExperimentHarness({ trialCount: 1 });
    harness.seedAttempt(0, 0, { status: 'preparing', withProvenance: true });
    const runner = createFakeTrialRunner(() => Promise.resolve(completedResult()));

    const result = await runExperiment({ ...harness.input, trialRunner: runner.run });

    expect(runner.calls[0]?.attemptId).toBe(harness.attemptId(0, 1));
    expect(result.results[0]).toMatchObject({ attemptIndex: 1, resumeAction: 'new_attempt' });
  });

  it('counts infrastructure incidents across all attempts when deciding retries', async () => {
    const harness = createExperimentHarness({ trialCount: 1, maxInfraRetries: 1 });
    harness.seedAttempt(0, 0, { status: 'running' });
    harness.seedAttempt(0, 1, { status: 'infrastructure_failed' });
    const runner = createFakeTrialRunner(() => Promise.resolve(completedResult()));

    const result = await runExperiment({ ...harness.input, trialRunner: runner.run });

    expect(runner.calls).toHaveLength(0);
    expect(result.exhaustedTrials).toEqual([harness.trialIds[0]]);
    expect(result.configDrift).toBe(false);
  });

  it('resumes a grading attempt from its checkpoint without a new attempt', async () => {
    const harness = createExperimentHarness({ trialCount: 1 });
    harness.seedAttempt(0, 0, { status: 'grading', withProvenance: true });
    const runner = createFakeTrialRunner(() => Promise.resolve(completedResult()));

    const result = await runExperiment({ ...harness.input, trialRunner: runner.run });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({
      attemptId: harness.attemptId(0, 0),
      resumeFromStatus: 'grading',
    });
    expect(result.results[0]).toMatchObject({
      attemptIndex: 0,
      status: 'completed',
      resumeAction: 'resume',
    });
  });

  it('recognizes the highest attempt index instead of only attempt 0', async () => {
    const harness = createExperimentHarness({ trialCount: 1 });
    harness.seedAttempt(0, 0, { status: 'infrastructure_failed' });
    harness.seedAttempt(0, 1, { status: 'completed', grade: 'verified_success' });
    const runner = createFakeTrialRunner(() => Promise.resolve(completedResult()));

    const result = await runExperiment({ ...harness.input, trialRunner: runner.run });

    expect(runner.calls).toHaveLength(0);
    expect(result.results[0]).toMatchObject({
      attemptId: harness.attemptId(0, 1),
      attemptIndex: 1,
      status: 'completed',
      gradeStatus: 'verified_success',
      resumeAction: 'skip',
    });
  });

  it('retries infrastructure failures with a new attempt while within the retry budget', async () => {
    const harness = createExperimentHarness({ trialCount: 1, maxInfraRetries: 2 });
    harness.seedAttempt(0, 0, { status: 'infrastructure_failed' });
    harness.seedAttempt(0, 1, { status: 'infrastructure_failed' });
    const runner = createFakeTrialRunner(() => Promise.resolve(completedResult()));

    const result = await runExperiment({ ...harness.input, trialRunner: runner.run });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.attemptId).toBe(harness.attemptId(0, 2));
    expect(runner.calls[0]?.resumeFromStatus).toBeUndefined();
    expect(result.results[0]).toMatchObject({
      attemptIndex: 2,
      status: 'completed',
      resumeAction: 'new_attempt',
    });
    expect(result.exhaustedTrials).toEqual([]);
  });

  it('reports INFRA_RETRY_EXHAUSTED (not config drift) once the retry budget is spent', async () => {
    const harness = createExperimentHarness({ trialCount: 1, maxInfraRetries: 2 });
    harness.seedAttempt(0, 0, { status: 'infrastructure_failed' });
    harness.seedAttempt(0, 1, { status: 'infrastructure_failed' });
    harness.seedAttempt(0, 2, { status: 'infrastructure_failed' });
    const runner = createFakeTrialRunner(() => Promise.resolve(completedResult()));

    const result = await runExperiment({ ...harness.input, trialRunner: runner.run });

    expect(runner.calls).toHaveLength(0);
    expect(result.exhaustedTrials).toEqual([harness.trialIds[0]]);
    expect(result.configDrift).toBe(false);
    expect(result.driftedTrials).toEqual([]);
    expect(result.results[0]).toMatchObject({
      attemptIndex: 2,
      status: 'infrastructure_failed',
      gradeStatus: 'invalid_trial',
      resumeAction: 'infra_retry_exhausted',
      reason: RESUME_ERROR_CODES.INFRA_RETRY_EXHAUSTED,
    });
    const summary = readJson(result.summaryPath);
    expect(summary).toMatchObject({ exhaustedTrials: [harness.trialIds[0]] });
  });

  it('starts a new attempt for an abandoned running attempt', async () => {
    const harness = createExperimentHarness({ trialCount: 1 });
    harness.seedAttempt(0, 0, { status: 'running', withProvenance: true });
    const runner = createFakeTrialRunner(() => Promise.resolve(completedResult()));

    const result = await runExperiment({ ...harness.input, trialRunner: runner.run });

    expect(runner.calls[0]?.attemptId).toBe(harness.attemptId(0, 1));
    expect(runner.calls[0]?.resumeFromStatus).toBeUndefined();
    expect(result.results[0]).toMatchObject({ attemptIndex: 1, resumeAction: 'new_attempt' });
  });

  it('does not retry agent failures and reports their stored grade', async () => {
    const harness = createExperimentHarness({ trialCount: 2 });
    harness.seedAttempt(0, 0, { status: 'agent_failed', grade: 'incorrect' });
    harness.seedAttempt(1, 0, { status: 'timed_out' });
    const runner = createFakeTrialRunner(() => Promise.resolve(completedResult()));

    const result = await runExperiment({ ...harness.input, trialRunner: runner.run });

    expect(runner.calls).toHaveLength(0);
    expect(result.results[0]).toMatchObject({
      status: 'agent_failed',
      gradeStatus: 'incorrect',
      resumeAction: 'skip',
    });
    expect(result.results[1]).toMatchObject({
      status: 'timed_out',
      gradeStatus: 'not_graded',
      resumeAction: 'skip',
    });
    expect(result.completedTrials).toBe(0);
  });

  it('blocks resume with CONFIG_DRIFT when a stored fingerprint changed', async () => {
    const harness = createExperimentHarness({ trialCount: 1 });
    harness.seedAttempt(0, 0, {
      status: 'grading',
      fingerprints: { agentFingerprint: 'agent-other' },
    });
    const runner = createFakeTrialRunner(() => Promise.resolve(completedResult()));

    const result = await runExperiment({ ...harness.input, trialRunner: runner.run });

    expect(runner.calls).toHaveLength(0);
    expect(result.configDrift).toBe(true);
    expect(result.driftedTrials).toEqual([harness.trialIds[0]]);
    expect(result.results[0]).toMatchObject({
      status: 'infrastructure_failed',
      gradeStatus: 'invalid_trial',
      resumeAction: 'config_drift',
    });
    expect(result.results[0]?.reason).toContain(RESUME_ERROR_CODES.CONFIG_DRIFT);
    expect(result.results[0]?.reason).toContain('agentFingerprint');
  });

  it('blocks resume on runner version drift', async () => {
    const harness = createExperimentHarness({ trialCount: 1 });
    harness.seedAttempt(0, 0, { status: 'grading', runnerVersion: '0.0.1' });
    const runner = createFakeTrialRunner(() => Promise.resolve(completedResult()));

    const result = await runExperiment({ ...harness.input, trialRunner: runner.run });

    expect(runner.calls).toHaveLength(0);
    expect(result.results[0]?.reason).toContain('runnerVersion');
  });

  it('treats attempts without stored fingerprints as unknown provenance drift', async () => {
    const harness = createExperimentHarness({ trialCount: 1 });
    harness.seedAttempt(0, 0, { status: 'grading', fingerprints: null, runnerVersion: null });
    const runner = createFakeTrialRunner(() => Promise.resolve(completedResult()));

    const result = await runExperiment({ ...harness.input, trialRunner: runner.run });

    expect(runner.calls).toHaveLength(0);
    expect(result.configDrift).toBe(true);
    expect(result.results[0]?.resumeAction).toBe('config_drift');
    expect(result.results[0]?.reason).toContain(RESUME_ERROR_CODES.UNKNOWN_PROVENANCE);
  });

  it('prefers runner-owned provenance.json over state.json fields for drift checks', async () => {
    const harness = createExperimentHarness({ trialCount: 1 });
    // state.json was overwritten by a checkpoint without fingerprints, but provenance.json exists.
    harness.seedAttempt(0, 0, { status: 'grading', withProvenance: true });
    const statePath = join(harness.attemptDir(0, 0), 'state.json');
    const raw = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    const stripped = {
      schemaVersion: raw['schemaVersion'],
      trialId: raw['trialId'],
      attemptId: raw['attemptId'],
      status: raw['status'],
    };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(statePath, JSON.stringify(stripped), 'utf8');
    const runner = createFakeTrialRunner(() => Promise.resolve(completedResult()));

    const result = await runExperiment({ ...harness.input, trialRunner: runner.run });

    expect(result.configDrift).toBe(false);
    expect(runner.calls[0]?.resumeFromStatus).toBe('grading');
  });

  it('keeps results in plan order even when trials complete out of order', async () => {
    const harness = createExperimentHarness({ trialCount: 4, concurrency: 4 });
    const completionOrder: string[] = [];
    const blockers = new Map(harness.trialIds.map((trialId) => [trialId, createDeferred()]));
    const finished = new Map(harness.trialIds.map((trialId) => [trialId, createDeferred()]));
    const allStarted = createDeferred();
    let started = 0;
    const runner = createFakeTrialRunner(async (input) => {
      started += 1;
      if (started === 4) {
        allStarted.resolve();
      }
      const blocker = blockers.get(input.trialId);
      const done = finished.get(input.trialId);
      if (blocker === undefined || done === undefined) {
        throw new Error(`missing gate for ${input.trialId}`);
      }
      await blocker.promise;
      completionOrder.push(input.trialId);
      done.resolve();
      return completedResult();
    });

    const running = runExperiment({ ...harness.input, trialRunner: runner.run });
    await allStarted.promise;
    for (const trialId of [...harness.trialIds].reverse()) {
      blockers.get(trialId)?.resolve();
      await finished.get(trialId)?.promise;
    }
    const result = await running;

    expect(completionOrder).toEqual([...harness.trialIds].reverse());
    expect(result.results.map((entry) => entry.trialId)).toEqual(harness.trialIds);
  });

  it('stops scheduling after an interrupt, awaits in-flight trials, and reports cancellation', async () => {
    const harness = createExperimentHarness({ trialCount: 4, concurrency: 1 });
    const emitter = new EventEmitter();
    let interrupts = 0;
    const runner = createFakeTrialRunner(async (_input, callIndex) => {
      if (callIndex === 0) {
        emitter.emit('SIGINT');
        await sleep(10);
      }
      return completedResult();
    });

    const result = await runExperiment({
      ...harness.input,
      trialRunner: runner.run,
      sigintEmitter: emitter,
      onInterrupt: () => {
        interrupts += 1;
      },
    });

    expect(interrupts).toBe(1);
    expect(runner.calls).toHaveLength(1);
    expect(result.cancelled).toBe(true);
    expect(result.cancellation).toEqual({ cancelled: true, unscheduledTrials: 3 });
    expect(result.results).toHaveLength(1);
    expect(readJson(result.summaryPath)).toMatchObject({ cancelled: true, unscheduledTrials: 3 });
    expect(existsSync(join(harness.experimentRoot, 'lock.json'))).toBe(false);
  });

  it('releases the lock and rethrows when the trial runner fails', async () => {
    const harness = createExperimentHarness({ trialCount: 3, concurrency: 1 });
    const runner = createFakeTrialRunner((_input, callIndex) =>
      callIndex === 0
        ? Promise.reject(new Error('runner exploded'))
        : Promise.resolve(completedResult()),
    );

    await expect(runExperiment({ ...harness.input, trialRunner: runner.run })).rejects.toThrow(
      'runner exploded',
    );

    expect(runner.calls).toHaveLength(1);
    expect(existsSync(join(harness.experimentRoot, 'lock.json'))).toBe(false);
    expect(existsSync(join(harness.experimentRoot, RUN_SUMMARY_FILENAME))).toBe(false);
  });
});
