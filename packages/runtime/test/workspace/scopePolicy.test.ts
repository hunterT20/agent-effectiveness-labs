import { describe, expect, it } from 'vitest';

import { evaluateScopePolicy, matchesGlob } from '../../src/workspace/scopePolicy.js';

describe('evaluateScopePolicy', () => {
  it('flags forbidden, outside-allowed, and maxChangedFiles as violations', () => {
    const evaluation = evaluateScopePolicy({
      changedPaths: ['src/a.ts', 'src/b.ts', 'secrets.env'],
      allowedPaths: ['src/**'],
      forbiddenPaths: ['secrets.env'],
      maxChangedFiles: 1,
    });
    expect(evaluation.violation).toBe(true);
    expect(evaluation.forbiddenHits).toEqual(['secrets.env']);
    expect(evaluation.outsideAllowed).toEqual([]);
    expect(evaluation.reasons.some((reason) => reason.includes('limit 1'))).toBe(true);
  });

  it('treats prefix paths as directory matches', () => {
    expect(matchesGlob('src', 'src/a.ts')).toBe(true);
    expect(matchesGlob('src/**', 'src/nested/a.ts')).toBe(true);
    expect(matchesGlob('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matchesGlob('src/*.ts', 'src/nested/a.ts')).toBe(false);
  });
});
