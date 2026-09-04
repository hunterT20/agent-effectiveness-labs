import {
  GATE_IDS,
  type BlindedAgreementEvidence,
  type ExperimentStatisticsLike,
  type ExperimentVerdict,
  type GateResult,
  type TelemetryCoverageSummary,
} from '@ael/core';

export interface ReportSource {
  readonly schemaVersion: 1;
  readonly experimentId: string;
  readonly suiteName: string;
  readonly verdict: ExperimentVerdict;
  readonly gates: readonly GateResult[];
  readonly statistics: ExperimentStatisticsLike;
  readonly generatedAt: string;
  readonly blindedAgreement?: BlindedAgreementEvidence | null;
  readonly telemetryCoverage?: TelemetryCoverageSummary | null;
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
  ];

  const lowPowerGate = report.gates.find((gate) => gate.id === GATE_IDS.LOW_POWER);
  if (
    lowPowerGate !== undefined &&
    (lowPowerGate.status === 'warning' || lowPowerGate.status === 'insufficient_data')
  ) {
    lines.push('## LOW_POWER', '', `**LOW_POWER** — ${lowPowerGate.message}`, '');
  }

  lines.push(
    '## Summary',
    '',
    `- Independent fixtures: ${String(report.statistics.independentFixtureCount)}`,
    `- Trials: ${String(report.statistics.trialCount)}`,
    `- Completed pairs: ${formatNullable(report.statistics.completedPairs ?? null)}`,
    `- Discordant pairs: ${formatNullable(report.statistics.discordantPairs ?? null)}`,
    `- Control verified success rate: ${formatNullable(report.statistics.controlVerifiedSuccessRate)}`,
    `- Treatment verified success rate: ${formatNullable(report.statistics.treatmentVerifiedSuccessRate)}`,
    `- Verified success delta: ${formatNullable(report.statistics.verifiedSuccessDelta)}`,
    `- Infrastructure failure rate: ${formatNullable(report.statistics.infrastructureFailureRate)}`,
    '',
    '## Gates',
    '',
  );

  for (const gate of report.gates) {
    lines.push(`- ${gate.id}: ${gate.status} (${gate.message}) ${formatEvidence(gate.evidencePaths)}`);
  }

  const bootstrap = report.statistics.bootstrap;
  if (bootstrap !== undefined) {
    lines.push(
      '',
      '## Cluster bootstrap',
      '',
      `- Method: ${bootstrap.method}`,
      `- Version: ${bootstrap.version}`,
      `- Statistic: ${bootstrap.statistic}`,
      `- Point estimate: ${formatNullable(bootstrap.pointEstimate)}`,
      `- CI: [${formatNullable(bootstrap.lower)}, ${formatNullable(bootstrap.upper)}]`,
      `- Iterations: ${String(bootstrap.iterations)}`,
    );
  }

  const holm = report.statistics.holm;
  if (holm !== undefined && holm !== null) {
    lines.push('', '## Holm correction', '', `- Version: ${holm.version}`, `- Alpha: ${String(holm.alpha)}`);
    for (const comparison of holm.comparisons) {
      lines.push(
        `- ${comparison.id}: raw=${String(comparison.rawPValue)} adjusted=${String(comparison.adjustedPValue)} significant=${String(comparison.significant)}`,
      );
    }
  }

  const secondary = report.statistics.secondaryComparisons;
  if (secondary !== undefined && secondary.length > 0) {
    lines.push('', '## Secondary comparisons', '');
    for (const comparison of secondary) {
      lines.push(
        `- ${comparison.treatmentArm}: delta=${formatNullable(comparison.verifiedSuccessDelta)} raw p=${formatNullable(comparison.rawPValue)} adjusted p=${formatNullable(comparison.adjustedPValue)}`,
      );
    }
  }

  const power = report.statistics.powerReadiness;
  if (power !== undefined) {
    lines.push(
      '',
      '## Power readiness',
      '',
      `- Version: ${power.version}`,
      `- Low power: ${String(power.lowPower)}`,
      `- Discordant pairs: ${String(power.discordantPairs)} / minimum ${String(power.minimumDiscordantPairs)}`,
      `- Minimum detectable delta: ${String(power.minimumDetectableDelta)}`,
    );
    for (const reason of power.reasons) {
      lines.push(`- ${reason}`);
    }
  }

  if (report.blindedAgreement !== undefined && report.blindedAgreement !== null) {
    const agreement = report.blindedAgreement;
    lines.push(
      '',
      '## Blinded agreement',
      '',
      `- Method: ${agreement.method}`,
      `- Kappa: ${formatNullable(agreement.kappa)}`,
      `- Adequate: ${String(agreement.adequate)}`,
      `- Adjudication complete: ${String(agreement.adjudicationComplete)}`,
      `- Evidence: ${agreement.evidencePath}`,
    );
  }

  const coverage = report.telemetryCoverage;
  if (coverage !== undefined && coverage !== null) {
    lines.push(
      '',
      '## Telemetry coverage',
      '',
      `- Exact: ${String(coverage.exact)}`,
      `- Estimated: ${String(coverage.estimated)}`,
      `- Unavailable: ${String(coverage.unavailable)}`,
      `- Total: ${String(coverage.total)}`,
    );
  }

  const arms = report.statistics.arms;
  if (arms !== undefined && arms.length > 0) {
    lines.push('', '## Arms', '');
    for (const arm of arms) {
      lines.push(
        `- ${arm.armId}: completed=${String(arm.completedCount)}/${String(arm.trialCount)} success=${formatNullable(arm.verifiedSuccessRate)} median duration=${formatNullable(arm.medianDurationMs)}`,
      );
    }
  }

  const pairs = report.statistics.pairs;
  if (pairs !== undefined && pairs.length > 0) {
    lines.push('', '## Pairs', '');
    for (const pair of pairs) {
      lines.push(
        `- ${pair.fixtureId} r${String(pair.repeatIndex)}: ${pair.outcome}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

function formatNullable(value: number | null): string {
  return value === null ? 'unavailable' : String(value);
}

function formatEvidence(paths: readonly string[]): string {
  if (paths.length === 0) {
    return 'evidence: none';
  }
  return `evidence: ${paths.join(', ')}`;
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
        `<tr><td>${escapeHtml(gate.id)}</td><td>${escapeHtml(gate.status)}</td><td>${escapeHtml(gate.message)}</td><td>${escapeHtml(gate.evidencePaths.join(', '))}</td></tr>`,
    )
    .join('');

  const lowPowerBanner =
    report.gates.some(
      (gate) =>
        gate.id === GATE_IDS.LOW_POWER &&
        (gate.status === 'warning' || gate.status === 'insufficient_data'),
    )
      ? '<p><strong>LOW_POWER</strong></p>'
      : '';

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
  ${lowPowerBanner}
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
    <thead><tr><th>Gate</th><th>Status</th><th>Message</th><th>Evidence</th></tr></thead>
    <tbody>${gateRows}</tbody>
  </table>
</body>
</html>
`;
}
