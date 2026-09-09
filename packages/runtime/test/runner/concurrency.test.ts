import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ConcurrencyLimiter,
  SIGINT_EXIT_CODE,
  createCancellationToken,
  installSigintHandler,
} from '../../src/runner/concurrency.js';
import { runExperiment } from '../../src/runner/experimentRunner.js';
import {
  completedResult,
  createExperimentHarness,
  createFakeTrialRunner,
  sleep,
} from './experimentRunnerHarness.js';

function createDeferred(): { readonly promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('ConcurrencyLimiter', () => {
  it('rejects a non-positive or non-integer limit', () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow(RangeError);
    expect(() => new ConcurrencyLimiter(-1)).toThrow(RangeError);
    expect(() => new ConcurrencyLimiter(1.5)).toThrow(RangeError);
  });

  it('never lets more than `limit` callers hold a slot at once', async () => {
    const limiter = new ConcurrencyLimiter(3);
    let current = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 12 }, async () => {
        const release = await limiter.acquire();
        current += 1;
        peak = Math.max(peak, current);
        await sleep(15);
        current -= 1;
        release();
      }),
    );

    expect(peak).toBe(3);
    expect(peak).toBeLessThanOrEqual(3);
    expect(limiter.activeCount).toBe(0);
  });

  it('ignores a second release from the same acquire', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const first = await limiter.acquire();
    expect(limiter.activeCount).toBe(1);
    first();
    first();
    expect(limiter.activeCount).toBe(0);
    const second = await limiter.acquire();
    expect(limiter.activeCount).toBe(1);
    second();
  });
});

describe('createCancellationToken', () => {
  it('aborts its AbortSignal when cancel() is called', () => {
    const token = createCancellationToken();
    expect(token.cancelled).toBe(false);
    expect(token.signal.aborted).toBe(false);
    token.cancel();
    expect(token.cancelled).toBe(true);
    expect(token.signal.aborted).toBe(true);
  });
});

describe('installSigintHandler', () => {
  it('cancels on the first interrupt and force-exits 130 after cleanup on the second', async () => {
    const token = createCancellationToken();
    const firstCalls: number[] = [];
    const exits: number[] = [];
    const cleanup = createDeferred();
    let cleaned = false;
    const emitter = new EventEmitter();

    const remove = installSigintHandler(
      token,
      () => {
        firstCalls.push(1);
      },
      {
        emitter,
        forceExit: (code) => {
          exits.push(code);
        },
        onSecondInterrupt: () => {
          cleaned = true;
          cleanup.resolve();
        },
      },
    );

    try {
      emitter.emit('SIGINT');
      expect(token.cancelled).toBe(true);
      expect(firstCalls).toEqual([1]);
      expect(exits).toEqual([]);

      emitter.emit('SIGINT');
      await cleanup.promise;
      expect(cleaned).toBe(true);
      expect(exits).toEqual([SIGINT_EXIT_CODE]);

      emitter.emit('SIGINT');
      expect(exits).toEqual([SIGINT_EXIT_CODE]);
      expect(firstCalls).toEqual([1]);
    } finally {
      remove();
    }
  });

  it('force-exits even when second-interrupt cleanup throws', () => {
    const token = createCancellationToken();
    const exits: number[] = [];
    const emitter = new EventEmitter();
    const remove = installSigintHandler(token, () => undefined, {
      emitter,
      forceExit: (code) => {
        exits.push(code);
      },
      onSecondInterrupt: () => {
        throw new Error('cleanup failed');
      },
    });

    try {
      emitter.emit('SIGINT');
      emitter.emit('SIGINT');
      expect(exits).toEqual([SIGINT_EXIT_CODE]);
    } finally {
      remove();
    }
  });
});

describe('runExperiment concurrency', () => {
  it('overlaps mocked trials when concurrency is 3 and keeps unique workspaces in plan order', async () => {
    const harness = createExperimentHarness({ trialCount: 3, concurrency: 3 });
    const gate = createDeferred();
    let inFlight = 0;
    let peak = 0;
    const runner = createFakeTrialRunner(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      if (inFlight === 3) {
        gate.resolve();
      }
      await gate.promise;
      inFlight -= 1;
      return completedResult();
    });

    const result = await runExperiment({ ...harness.input, trialRunner: runner.run });

    expect(peak).toBe(3);
    expect(result.results.map((entry) => entry.trialId)).toEqual(harness.trialIds);
    const workspaceRoots = runner.calls.map((call) =>
      join(call.experimentRoot, 'trials', call.trialId, call.attemptId, 'workspace'),
    );
    expect(workspaceRoots).toHaveLength(3);
    expect(new Set(workspaceRoots).size).toBe(3);
    expect(new Set(runner.calls.map((call) => call.trialId)).size).toBe(3);
  });

  it('does not overlap mocked trials when concurrency is 1', async () => {
    const harness = createExperimentHarness({ trialCount: 3, concurrency: 1 });
    let inFlight = 0;
    let peak = 0;
    const runner = createFakeTrialRunner(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(20);
      inFlight -= 1;
      return completedResult();
    });

    await runExperiment({ ...harness.input, trialRunner: runner.run });

    expect(peak).toBe(1);
  });

  it('releases the lock then force-exits 130 on the second Ctrl+C', async () => {
    const harness = createExperimentHarness({ trialCount: 3, concurrency: 1 });
    const lockPath = join(harness.experimentRoot, 'lock.json');
    const exits: number[] = [];
    const emitter = new EventEmitter();
    const secondInterrupt = createDeferred();
    const runner = createFakeTrialRunner(async (_input, callIndex) => {
      if (callIndex === 0) {
        emitter.emit('SIGINT');
        emitter.emit('SIGINT');
        await secondInterrupt.promise;
      }
      return completedResult();
    });

    const result = await runExperiment({
      ...harness.input,
      trialRunner: runner.run,
      sigintEmitter: emitter,
      forceExit: (code) => {
        exits.push(code);
        secondInterrupt.resolve();
      },
    });

    expect(exits).toEqual([SIGINT_EXIT_CODE]);
    expect(result.cancelled).toBe(true);
    expect(runner.calls).toHaveLength(1);
    expect(existsSync(lockPath)).toBe(false);
  });
});
