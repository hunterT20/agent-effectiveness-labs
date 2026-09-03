import { createHash } from 'node:crypto';

export const PRNG_VERSION = 'mulberry32-v1' as const;

/** Derive a deterministic 32-bit seed from the suite randomSeed string. */
export function derivePrngSeed(randomSeed: string): number {
  const hash = createHash('sha256').update(randomSeed, 'utf8').digest();
  return hash.readUInt32LE(0);
}

/** mulberry32 deterministic PRNG returning values in [0, 1). */
export function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Fisher-Yates shuffle using the supplied RNG. */
export function shuffleDeterministic<T>(items: readonly T[], rng: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    const current = copy[index];
    const swap = copy[swapIndex];
    if (current !== undefined && swap !== undefined) {
      copy[index] = swap;
      copy[swapIndex] = current;
    }
  }
  return copy;
}
