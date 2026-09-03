import { describe, expect, it } from 'vitest';

import {
  buildReportSource,
  escapeCsvCell,
  escapeHtml,
  renderReportCsv,
  renderReportHtml,
} from '@ael/reporter';

describe('reporter CSV and HTML', () => {
  const report = buildReportSource({
    experimentId: '=cmd|"/c calc"!A0',
    suiteName: 'minimal',
    verdict: 'INSUFFICIENT_DATA',
    gates: [{ id: '@inject', status: 'failed', message: '<script>alert(1)</script>' }],
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

  it('escapes CSV formula injection prefixes', () => {
    expect(escapeCsvCell('=1+1')).toBe("'=1+1");
    expect(escapeCsvCell('+100')).toBe("'+100");
    expect(escapeCsvCell('-50')).toBe("'-50");
    expect(escapeCsvCell('@sum')).toBe("'@sum");
    const csv = renderReportCsv(report);
    expect(csv.includes("'=cmd")).toBe(true);
  });

  it('renders self-contained HTML with escaped content and CSP', () => {
    const html = renderReportHtml(report);
    expect(html).toContain('Content-Security-Policy');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml('<img onerror=alert(1)>')).not.toContain('<img');
  });

  it('renders deterministic CSV', () => {
    const first = renderReportCsv(report);
    const second = renderReportCsv(report);
    expect(first).toBe(second);
  });
});
