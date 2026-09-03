export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => {
        this.release();
      };
    }
    await new Promise<void>((resolve) => {
      this.queue.push(() => {
        resolve();
      });
    });
    this.active += 1;
    return () => {
      this.release();
    };
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next !== undefined) {
      next();
    }
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

export function installSigintHandler(
  token: CancellationToken,
  onInterrupt: () => void,
): () => void {
  const handler = () => {
    token.cancel();
    onInterrupt();
  };
  process.on('SIGINT', handler);
  return () => {
    process.off('SIGINT', handler);
  };
}
