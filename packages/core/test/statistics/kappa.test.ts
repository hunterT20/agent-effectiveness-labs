import { describe, expect, it } from 'vitest';

import {
  KAPPA_REASON_ALL_IDENTICAL,
  KAPPA_REASON_NO_PACKETS,
  KAPPA_REASON_TOO_FEW_RATERS,
  KAPPA_REASON_UNEQUAL_RATERS,
  cohenKappa,
  fleissKappa,
  pairwisePercentAgreement,
} from '@ael/core';

function repeat(label: string, count: number): string[] {
  return Array.from({ length: count }, () => label);
}

describe("Cohen's kappa", () => {
  it('matches the textbook 2x2 example (po=0.7, pe=0.5, kappa=0.4)', () => {
    // Rater A vs rater B over 50 items:
    // yes/yes 20, A yes/B no 5, A no/B yes 10, no/no 15.
    const left = [
      ...repeat('yes', 20),
      ...repeat('yes', 5),
      ...repeat('no', 10),
      ...repeat('no', 15),
    ];
    const right = [
      ...repeat('yes', 20),
      ...repeat('no', 5),
      ...repeat('yes', 10),
      ...repeat('no', 15),
    ];
    const result = cohenKappa(left, right);
    expect(result.method).toBe('cohen-kappa');
    expect(result.packetCount).toBe(50);
    expect(result.observedAgreement).toBeCloseTo(0.7, 10);
    expect(result.expectedAgreement).toBeCloseTo(0.5, 10);
    expect(result.kappa).toBeCloseTo(0.4, 10);
    expect(result.reason).toBeNull();
  });

  it('returns 0 when agreement equals chance', () => {
    // Each rater says pass half the time, independently: po = pe = 0.5.
    const left = ['pass', 'pass', 'fail', 'fail'];
    const right = ['pass', 'fail', 'pass', 'fail'];
    expect(cohenKappa(left, right).kappa).toBeCloseTo(0, 10);
  });

  it('returns -1 for perfectly opposite two-category ratings', () => {
    const left = ['pass', 'fail', 'pass', 'fail'];
    const right = ['fail', 'pass', 'fail', 'pass'];
    expect(cohenKappa(left, right).kappa).toBeCloseTo(-1, 10);
  });

  it('reports 1 with an explicit reason when all ratings are identical', () => {
    const result = cohenKappa(['pass', 'pass', 'pass'], ['pass', 'pass', 'pass']);
    expect(result.kappa).toBe(1);
    expect(result.observedAgreement).toBe(1);
    expect(result.reason).toBe(KAPPA_REASON_ALL_IDENTICAL);
  });

  it('returns null with a reason when there are no packets', () => {
    const result = cohenKappa([], []);
    expect(result.kappa).toBeNull();
    expect(result.reason).toBe(KAPPA_REASON_NO_PACKETS);
  });
});

describe("Fleiss' kappa", () => {
  it('matches the textbook 10-subject / 14-rater / 5-category example (kappa=0.210)', () => {
    const counts = [
      [0, 0, 0, 0, 14],
      [0, 2, 6, 4, 2],
      [0, 0, 3, 5, 6],
      [0, 3, 9, 2, 0],
      [2, 2, 8, 1, 1],
      [7, 7, 0, 0, 0],
      [3, 2, 6, 3, 0],
      [2, 5, 3, 2, 2],
      [6, 5, 2, 1, 0],
      [0, 2, 2, 3, 7],
    ];
    const rows = counts.map((row) =>
      row.flatMap((count, category) => repeat(`c${String(category + 1)}`, count)),
    );
    const result = fleissKappa(rows);
    expect(result.method).toBe('fleiss-kappa');
    expect(result.packetCount).toBe(10);
    expect(result.raterCount).toBe(14);
    expect(result.observedAgreement).toBeCloseTo(0.378, 3);
    expect(result.expectedAgreement).toBeCloseTo(0.213, 3);
    expect(result.kappa).toBeCloseTo(0.21, 3);
    expect(result.reason).toBeNull();
  });

  it('reduces to Cohen-like values for two raters with symmetric marginals', () => {
    // 3 raters, 4 packets: full agreement on 2 packets, split on 2.
    const rows = [
      ['pass', 'pass', 'pass'],
      ['fail', 'fail', 'fail'],
      ['pass', 'pass', 'fail'],
      ['fail', 'fail', 'pass'],
    ];
    // P_i: 1, 1, 1/3, 1/3 -> Pbar = 2/3. p_pass = 6/12, p_fail = 6/12 -> Pe = 0.5.
    // kappa = (2/3 - 1/2) / (1 - 1/2) = 1/3.
    const result = fleissKappa(rows);
    expect(result.observedAgreement).toBeCloseTo(2 / 3, 10);
    expect(result.expectedAgreement).toBeCloseTo(0.5, 10);
    expect(result.kappa).toBeCloseTo(1 / 3, 10);
  });

  it('matches a two-rater four-packet worked example (kappa=0)', () => {
    const rows = [
      ['pass', 'pass'],
      ['fail', 'fail'],
      ['pass', 'fail'],
      ['fail', 'pass'],
    ];
    const result = fleissKappa(rows);
    expect(result.observedAgreement).toBeCloseTo(0.5, 10);
    expect(result.expectedAgreement).toBeCloseTo(0.5, 10);
    expect(result.kappa).toBeCloseTo(0, 10);
  });

  it('reports 1 with a reason when all ratings are identical', () => {
    const result = fleissKappa([
      ['pass', 'pass', 'pass'],
      ['pass', 'pass', 'pass'],
    ]);
    expect(result.kappa).toBe(1);
    expect(result.reason).toBe(KAPPA_REASON_ALL_IDENTICAL);
  });

  it('returns null with reasons for empty, single-rater, and unequal designs', () => {
    expect(fleissKappa([]).reason).toBe(KAPPA_REASON_NO_PACKETS);
    expect(fleissKappa([['pass'], ['fail']]).reason).toBe(KAPPA_REASON_TOO_FEW_RATERS);
    const unequal = fleissKappa([
      ['pass', 'fail', 'pass'],
      ['pass', 'fail'],
    ]);
    expect(unequal.kappa).toBeNull();
    expect(unequal.reason).toBe(KAPPA_REASON_UNEQUAL_RATERS);
  });
});

describe('pairwise percent agreement', () => {
  it('averages pairwise agreement across packets with varying rater counts', () => {
    const result = pairwisePercentAgreement([
      ['pass', 'pass', 'fail'], // 1 of 3 pairs agree
      ['pass', 'pass'], // 1 of 1
      ['fail'], // ignored (< 2 raters)
    ]);
    expect(result.packetCount).toBe(2);
    expect(result.observedAgreement).toBeCloseTo((1 / 3 + 1) / 2, 10);
  });
});
