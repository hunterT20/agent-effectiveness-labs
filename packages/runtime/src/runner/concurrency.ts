export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(
        `ConcurrencyLimiter limit must be a positive integer, got ${String(limit)}`,
      );
    }
  }

  /** Number of slots currently held. */
  get activeCount(): number {
    return this.active;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return this.createReleaser();
    }
    await new Promise<void>((resolve) => {
      this.queue.push(() => {
        resolve();
      });
    });
    // The waking `release()` transferred its slot; `active` is unchanged.
    return this.createReleaser();
  }

  private createReleaser(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.release();
    };
  }

  private release(): void {
    const next = this.queue.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.active -= 1;
  }
}

export interface CancellationToken {
  readonly cancelled: boolean;
  cancel(): void;
}

export function createCancellationToken(): CancellationToken {
  const state = { cancelled: false };
  return {
    get cancelled() {
      return state.cancelled;
    },
    cancel() {
      state.cancelled = true;
    },
  };
}

export interface SigintHandlerOptions {
  /**
   * Called on the second interrupt, after `onSecondInterrupt` cleanup resolves (or rejects).
   * Defaults to `process.exit(130)`.
   */
  readonly forceExit?: (code: number) => void;
  /** Best-effort cleanup (e.g. releasing the experiment lock) before forcing exit. */
  readonly onSecondInterrupt?: () => Promise<void> | void;
  /** Defaults to `process`. Tests inject an EventEmitter so they never emit a real SIGINT. */
  readonly emitter?: SigintEmitter;
}

export interface SigintEmitter {
  on(event: 'SIGINT', listener: () => void): unknown;
  off(event: 'SIGINT', listener: () => void): unknown;
}

export const SIGINT_EXIT_CODE = 130;

/**
 * First Ctrl+C: cancel the token so no new trials are scheduled and in-flight trials wind down.
 * Second Ctrl+C: run best-effort cleanup then force the process to exit with code 130.
 *
 * Killing the in-flight agent process on the first interrupt is wired by the process supervisor
 * once it accepts an `AbortSignal`; until then the in-flight trial is awaited.
 */
export function installSigintHandler(
  token: CancellationToken,
  onInterrupt: () => void,
  options: SigintHandlerOptions = {},
): () => void {
  const forceExit = options.forceExit ?? ((code: number) => process.exit(code));
  const emitter = options.emitter ?? process;
  let interrupts = 0;
  const handler = () => {
    interrupts += 1;
    if (interrupts === 1) {
      token.cancel();
      onInterrupt();
      return;
    }
    if (interrupts > 2) {
      return;
    }
    const cleanup = options.onSecondInterrupt;
    const finish = () => {
      forceExit(SIGINT_EXIT_CODE);
    };
    if (cleanup === undefined) {
      finish();
      return;
    }
    let pending: Promise<void> | void;
    try {
      pending = cleanup();
    } catch {
      finish();
      return;
    }
    if (pending instanceof Promise) {
      pending.then(finish, finish);
    } else {
      finish();
    }
  };
  emitter.on('SIGINT', handler);
  return () => {
    emitter.off('SIGINT', handler);
  };
}
