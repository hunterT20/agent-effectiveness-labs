import { describe, expect, it } from 'vitest';

import { buildReportSource, renderReportMarkdown, serializeReportJson } from '@ael/reporter';

describe('reporter', () => {
  it('renders deterministic markdown from normalized report json', () => {
    const report = buildReportSource({
      experimentId: 'exp-1',
      suiteName: 'minimal',
      verdict: 'INSUFFICIENT_DATA',
      gates: [],
      statistics: {
        independentFixtureCount: 3,
        trialCount: 6,
        pairedSignTest: {
          improvements: 0,
          regressions: 0,
          ties: 0,
          pValueOneSided: null,
          pValueTwoSided: null,
        },
        verifiedSuccessDelta: null,
        controlVerifiedSuccessRate: null,
        treatmentVerifiedSuccessRate: null,
        controlMedianDurationMs: null,
        treatmentMedianDurationMs: null,
        controlP90DurationMs: null,
        treatmentP90DurationMs: null,
        controlP95DurationMs: null,
        treatmentP95DurationMs: null,
        infrastructureFailureRate: null,
      },
    });
    const first = renderReportMarkdown(report);
    const second = renderReportMarkdown(report);
    expect(first).toBe(second);
    expect(serializeReportJson(report)).toContain('"experimentId": "exp-1"');
  });
});
