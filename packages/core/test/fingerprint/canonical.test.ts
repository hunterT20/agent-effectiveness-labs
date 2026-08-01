import { describe, expect, it } from 'vitest';

import { canonicalizeJson, computeFingerprint } from '@ael/core';

describe('canonical fingerprints', () => {
  it('yields the same RFC 8785 fingerprint for semantically equal documents', () => {
    const left = { schemaVersion: 1, id: 'suite-a', nested: { b: 2, a: 1 } };
    const right = { nested: { a: 1, b: 2 }, id: 'suite-a', schemaVersion: 1 };

    expect(canonicalizeJson(left)).toBe(canonicalizeJson(right));
    expect(computeFingerprint(left)).toBe(computeFingerprint(right));
  });

  it('changes the fingerprint when one field changes', () => {
    const base = { schemaVersion: 1, id: 'suite-a', repeats: 5 };
    const changed = { schemaVersion: 1, id: 'suite-a', repeats: 6 };

    expect(computeFingerprint(base)).not.toBe(computeFingerprint(changed));
  });
});
