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

const FORMULA_PREFIXES = ['=', '+', '-', '@'];

export function escapeCsvCell(value: string): string {
  let cell = value;
  if (FORMULA_PREFIXES.some((prefix) => cell.startsWith(prefix))) {
    cell = `'${cell}`;
  }
  if (cell.includes('"') || cell.includes(',') || cell.includes('\n') || cell.includes('\r')) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

export function renderReportCsv(report: ReportSource): string {
  const headers = [
    'experimentId',
    'suiteName',
    'verdict',
    'independentFixtureCount',
    'trialCount',
    'controlVerifiedSuccessRate',
    'treatmentVerifiedSuccessRate',
    'verifiedSuccessDelta',
  ];
  const row = [
    report.experimentId,
    report.suiteName,
    report.verdict,
    String(report.statistics.independentFixtureCount),
    String(report.statistics.trialCount),
    formatNullable(report.statistics.controlVerifiedSuccessRate),
    formatNullable(report.statistics.treatmentVerifiedSuccessRate),
    formatNullable(report.statistics.verifiedSuccessDelta),
  ];
  const lines = [headers.map(escapeCsvCell).join(','), row.map(escapeCsvCell).join(',')];
  for (const gate of report.gates) {
    lines.push([gate.id, gate.status, gate.message].map(escapeCsvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderReportHtml(report: ReportSource): string {
  const gateRows = report.gates
    .map(
      (gate) =>
        `<tr><td>${escapeHtml(gate.id)}</td><td>${escapeHtml(gate.status)}</td><td>${escapeHtml(gate.message)}</td></tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>AEL Report — ${escapeHtml(report.experimentId)}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; color: #111; }
    h1 { font-size: 1.5rem; }
    table { border-collapse: collapse; margin-top: 1rem; }
    th, td { border: 1px solid #ccc; padding: 0.5rem 0.75rem; text-align: left; }
    th { background: #f4f4f4; }
  </style>
</head>
<body>
  <h1>Agent Effectiveness Labs Report</h1>
  <p><strong>Experiment:</strong> ${escapeHtml(report.experimentId)}</p>
  <p><strong>Suite:</strong> ${escapeHtml(report.suiteName)}</p>
  <p><strong>Verdict:</strong> ${escapeHtml(report.verdict)}</p>
  <h2>Summary</h2>
  <ul>
    <li>Independent fixtures: ${escapeHtml(String(report.statistics.independentFixtureCount))}</li>
    <li>Trial count: ${escapeHtml(String(report.statistics.trialCount))}</li>
    <li>Control verified success rate: ${escapeHtml(formatNullable(report.statistics.controlVerifiedSuccessRate))}</li>
    <li>Treatment verified success rate: ${escapeHtml(formatNullable(report.statistics.treatmentVerifiedSuccessRate))}</li>
    <li>Verified success delta: ${escapeHtml(formatNullable(report.statistics.verifiedSuccessDelta))}</li>
  </ul>
  <h2>Gates</h2>
  <table>
    <thead><tr><th>Gate</th><th>Status</th><th>Message</th></tr></thead>
    <tbody>${gateRows}</tbody>
  </table>
</body>
</html>
`;
}
