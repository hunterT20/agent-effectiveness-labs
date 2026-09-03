import type { SuiteDocument } from '../config/schemas.js';
import type { GateResult } from '../contracts/verdict.js';
import type { ExperimentStatistics, ExperimentVerdict } from '../statistics/summary.js';

export interface EvaluateGatesInput {
  readonly decisionPolicy: SuiteDocument['decisionPolicy'];
  readonly decisionPolicyMode: 'exploratory' | 'preregistered';
  readonly statistics: ExperimentStatistics;
  readonly completedPairs: number;
  readonly evidenceRoot: string;
}

function gate(
  id: string,
  status: GateResult['status'],
  actual: number | null,
  expected: string,
  message: string,
  evidencePaths: string[] = [],
): GateResult {
  return { id, status, actual, expected, message, evidencePaths };
}

export function evaluateGates(input: EvaluateGatesInput): GateResult[] {
  const { decisionPolicy, statistics, completedPairs, evidenceRoot } = input;
  const evidence = [evidenceRoot];

  const gates: GateResult[] = [
    gate(
      'minimum-completed-pairs',
      completedPairs >= decisionPolicy.minimumCompletedPairs ? 'passed' : 'insufficient_data',
      completedPairs,
      `>= ${String(decisionPolicy.minimumCompletedPairs)}`,
      'Completed pair count versus preregistered minimum',
      evidence,
    ),
    gate(
      'minimum-independent-fixtures',
      statistics.independentFixtureCount >= decisionPolicy.minimumIndependentFixtures
        ? 'passed'
        : 'insufficient_data',
      statistics.independentFixtureCount,
      `>= ${String(decisionPolicy.minimumIndependentFixtures)}`,
      'Independent fixture count versus preregistered minimum',
      evidence,
    ),
    gate(
      'maximum-infrastructure-failure-rate',
      statistics.infrastructureFailureRate !== null &&
        statistics.infrastructureFailureRate <= decisionPolicy.maximumInfrastructureFailureRate
        ? 'passed'
        : 'insufficient_data',
      statistics.infrastructureFailureRate,
      `<= ${String(decisionPolicy.maximumInfrastructureFailureRate)}`,
      'Infrastructure failure rate within policy',
      evidence,
    ),
  ];

  if (input.decisionPolicyMode === 'preregistered') {
    const delta = statistics.verifiedSuccessDelta;
    gates.push(
      gate(
        'verified-success-delta',
        delta !== null && delta >= decisionPolicy.verifiedSuccessDeltaMin ? 'passed' : 'failed',
        delta,
        `>= ${String(decisionPolicy.verifiedSuccessDeltaMin)}`,
        'Treatment verified success delta versus control',
        evidence,
      ),
      gate(
        'paired-improvement-significance',
        statistics.pairedSignTest.pValueOneSided !== null &&
          statistics.pairedSignTest.pValueOneSided <= decisionPolicy.pairedImprovementPValueMax
          ? 'passed'
          : 'failed',
        statistics.pairedSignTest.pValueOneSided,
        `<= ${String(decisionPolicy.pairedImprovementPValueMax)}`,
        'One-sided paired sign test for improvement',
        evidence,
      ),
    );
  }

  return gates;
}

export function deriveVerdict(gates: readonly GateResult[]): ExperimentVerdict {
  if (gates.some((entry) => entry.status === 'failed')) {
    return 'FAILED';
  }
  if (gates.some((entry) => entry.status === 'insufficient_data')) {
    return 'INSUFFICIENT_DATA';
  }
  return 'PASSED';
}
