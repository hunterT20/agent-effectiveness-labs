import type { ExperimentStatistics, ExperimentVerdict } from '@ael/core';
import type { GateResult } from '@ael/core';

export interface ReportSource {
  readonly schemaVersion: 1;
  readonly experimentId: string;
  readonly suiteName: string;
  readonly verdict: ExperimentVerdict;
  readonly gates: readonly GateResult[];
  readonly statistics: ExperimentStatistics;
  readonly generatedAt: string;
}

export function buildReportSource(
  input: Omit<ReportSource, 'schemaVersion' | 'generatedAt'>,
): ReportSource {
  return {
    schemaVersion: 1,
    generatedAt: new Date(0).toISOString(),
    ...input,
  };
}

export function renderReportMarkdown(report: ReportSource): string {
  const lines = [
    '# Agent Effectiveness Labs Report',
    '',
    `Experiment: ${report.experimentId}`,
    `Suite: ${report.suiteName}`,
    `Verdict: ${report.verdict}`,
    '',
    '## Summary',
    '',
    `- Independent fixtures: ${String(report.statistics.independentFixtureCount)}`,
    `- Trials: ${String(report.statistics.trialCount)}`,
    `- Control verified success rate: ${formatNullable(report.statistics.controlVerifiedSuccessRate)}`,
    `- Treatment verified success rate: ${formatNullable(report.statistics.treatmentVerifiedSuccessRate)}`,
    `- Verified success delta: ${formatNullable(report.statistics.verifiedSuccessDelta)}`,
    '',
    '## Gates',
    '',
  ];

  for (const gate of report.gates) {
    lines.push(`- ${gate.id}: ${gate.status} (${gate.message})`);
  }

  return `${lines.join('\n')}\n`;
}

function formatNullable(value: number | null): string {
  return value === null ? 'unavailable' : String(value);
}

export function serializeReportJson(report: ReportSource): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
