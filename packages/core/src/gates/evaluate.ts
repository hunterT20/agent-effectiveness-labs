import type { SuiteDocument } from '../config/schemas.js';
import type { IsolationCapabilities } from '../contracts/isolation.js';
import { GATE_IDS, type GateResult } from '../contracts/verdict.js';
import type { ExperimentStatisticsLike, ExperimentVerdict } from '../statistics/experiment.js';

const ISOLATION_REQUIRE_KEYS = [
  'filesystemEnforced',
  'networkPolicyEnforced',
  'processTreeEnforced',
  'hiddenGraderProtected',
  'externalArtifactsProtected',
] as const satisfies ReadonlyArray<keyof SuiteDocument['isolation']['require']>;

/** Evidence recorded by `doctor` about isolation capabilities (read from `doctor.json`). */
export interface CapabilityEvidence {
  /** Path relative to the experiment root. */
  readonly evidencePath: string;
  /** Capabilities the suite required that the isolation provider could not enforce. */
  readonly unmetRequiredCapabilities: readonly string[];
}

/** Summary of blinded-rubric inter-rater agreement (read from `blinded/agreement.json`). */
export interface BlindedAgreementEvidence {
  readonly evidencePath: string;
  readonly method: 'cohen-kappa' | 'fleiss-kappa' | 'percent-agreement';
  readonly kappa: number | null;
  readonly minimumKappa: number;
  readonly adequate: boolean;
  readonly adjudicationComplete: boolean;
  readonly raterCount: number;
  readonly packetCount: number;
  readonly ratedPacketCount: number;
}

export interface SafetyViolationEvidence {
  readonly trialId: string;
  /** Path relative to the experiment root (typically the trial's grade.json). */
  readonly evidencePath: string;
}

export interface EvaluateGatesInput {
  readonly decisionPolicy: SuiteDocument['decisionPolicy'];
  readonly decisionPolicyMode: 'exploratory' | 'preregistered';
  readonly statistics: ExperimentStatisticsLike;
  readonly completedPairs: number;
  /**
   * Evidence path (relative to the experiment root) backing the statistical gates, e.g.
   * `report/report.json` or `attempts`. Additional paths may be supplied via `statisticsEvidencePaths`.
   */
  readonly evidenceRoot: string;
  readonly statisticsEvidencePaths?: readonly string[];
  /** Treatment trials with a grader-recorded safety violation. */
  readonly safetyViolations?: readonly SafetyViolationEvidence[];
  /** Capability names the suite requires (`isolation.require.* === true`). */
  readonly requiredCapabilities?: readonly string[];
  /** `null` when `doctor.json` is absent. */
  readonly capabilityEvidence?: CapabilityEvidence | null;
  /** `null` when `blinded/agreement.json` is absent. */
  readonly blindedAgreement?: BlindedAgreementEvidence | null;
}

function gate(
  id: string,
  status: GateResult['status'],
  actual: number | null,
  expected: string,
  message: string,
  evidencePaths: readonly string[],
): GateResult {
  return { id, status, actual, expected, message, evidencePaths: [...evidencePaths] };
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((path) => path.length > 0))];
}

function safetyGate(input: EvaluateGatesInput, evidence: readonly string[]): GateResult {
  const violations = input.safetyViolations ?? [];
  const count = Math.max(violations.length, input.statistics.treatmentSafetyViolations ?? 0);
  const max = input.decisionPolicy.treatmentCriticalSafetyMax;
  return gate(
    GATE_IDS.SAFETY_ZERO_TOLERANCE,
    count <= max ? 'passed' : 'failed',
    count,
    `<= ${String(max)}`,
    count <= max
      ? 'No treatment trial recorded a safety violation'
      : `Treatment trials with safety violations: ${violations
          .map((entry) => entry.trialId)
          .sort()
          .join(', ')}`,
    uniquePaths([...violations.map((entry) => entry.evidencePath), ...evidence]),
  );
}

function capabilityGate(input: EvaluateGatesInput): GateResult {
  const required = [...(input.requiredCapabilities ?? [])].sort();
  const evidence = input.capabilityEvidence ?? null;
  const expected = required.length === 0 ? 'no required capabilities' : required.join(', ');

  if (evidence === null) {
    return gate(
      GATE_IDS.CAPABILITY_REQUIREMENTS,
      'not_evaluated',
      null,
      expected,
      required.length === 0
        ? 'Suite requires no isolation capabilities and no doctor evidence was recorded'
        : 'doctor.json is missing; capability requirements were not evaluated',
      [],
    );
  }

  const unmet = [...evidence.unmetRequiredCapabilities].sort();
  return gate(
    GATE_IDS.CAPABILITY_REQUIREMENTS,
    unmet.length === 0 ? 'passed' : 'insufficient_data',
    unmet.length,
    expected,
    unmet.length === 0
      ? 'All required isolation capabilities were enforced'
      : `Required capabilities not enforced: ${unmet.join(', ')}`,
    [evidence.evidencePath],
  );
}

function blindedAgreementGate(input: EvaluateGatesInput): GateResult {
  const required = input.decisionPolicy.requireBlindedRubric === true;
  const agreement = input.blindedAgreement ?? null;

  if (agreement === null) {
    return gate(
      GATE_IDS.BLINDED_AGREEMENT,
      required ? 'insufficient_data' : 'not_evaluated',
      null,
      required ? 'agreement file present and adequate' : 'not required',
      required
        ? 'Blinded rubric agreement is required but blinded/agreement.json is missing'
        : 'No blinded rubric agreement recorded',
      [],
    );
  }

  const ok = agreement.adequate && agreement.adjudicationComplete;
  const detail = `${agreement.method} kappa=${agreement.kappa === null ? 'unavailable' : String(agreement.kappa)} raters=${String(agreement.raterCount)} rated=${String(agreement.ratedPacketCount)}/${String(agreement.packetCount)}`;
  return gate(
    GATE_IDS.BLINDED_AGREEMENT,
    ok ? 'passed' : 'insufficient_data',
    agreement.kappa,
    `kappa >= ${String(agreement.minimumKappa)} and adjudication complete`,
    ok
      ? `Inter-rater agreement adequate (${detail})`
      : agreement.adequate
        ? `Adjudication incomplete (${detail})`
        : `Inter-rater agreement inadequate (${detail})`,
    [agreement.evidencePath],
  );
}

function lowPowerGate(input: EvaluateGatesInput, evidence: readonly string[]): GateResult {
  const power = input.statistics.powerReadiness;
  if (power === undefined) {
    return gate(
      GATE_IDS.LOW_POWER,
      'not_evaluated',
      null,
      'power readiness computed',
      'Power readiness was not computed',
      evidence,
    );
  }
  const expected = `discordant pairs >= ${String(power.minimumDiscordantPairs)}; fixtures sufficient for delta ${String(power.minimumDetectableDelta)}`;
  if (!power.lowPower) {
    return gate(
      GATE_IDS.LOW_POWER,
      'passed',
      power.discordantPairs,
      expected,
      'Experiment is adequately powered for the preregistered effect size',
      evidence,
    );
  }
  return gate(
    GATE_IDS.LOW_POWER,
    input.decisionPolicyMode === 'preregistered' ? 'insufficient_data' : 'warning',
    power.discordantPairs,
    expected,
    `LOW_POWER: ${power.reasons.join('; ')}`,
    evidence,
  );
}

export function evaluateGates(input: EvaluateGatesInput): GateResult[] {
  const { decisionPolicy, statistics, completedPairs } = input;
  const evidence = uniquePaths([input.evidenceRoot, ...(input.statisticsEvidencePaths ?? [])]);

  const gates: GateResult[] = [
    gate(
      GATE_IDS.MINIMUM_COMPLETED_PAIRS,
      completedPairs >= decisionPolicy.minimumCompletedPairs ? 'passed' : 'insufficient_data',
      completedPairs,
      `>= ${String(decisionPolicy.minimumCompletedPairs)}`,
      'Completed pair count versus preregistered minimum',
      evidence,
    ),
    gate(
      GATE_IDS.MINIMUM_INDEPENDENT_FIXTURES,
      statistics.independentFixtureCount >= decisionPolicy.minimumIndependentFixtures
        ? 'passed'
        : 'insufficient_data',
      statistics.independentFixtureCount,
      `>= ${String(decisionPolicy.minimumIndependentFixtures)}`,
      'Independent fixture count versus preregistered minimum',
      evidence,
    ),
    gate(
      GATE_IDS.MAXIMUM_INFRASTRUCTURE_FAILURE_RATE,
      statistics.infrastructureFailureRate !== null &&
        statistics.infrastructureFailureRate <= decisionPolicy.maximumInfrastructureFailureRate
        ? 'passed'
        : 'insufficient_data',
      statistics.infrastructureFailureRate,
      `<= ${String(decisionPolicy.maximumInfrastructureFailureRate)}`,
      'Infrastructure failure rate within policy',
      evidence,
    ),
    safetyGate(input, evidence),
    capabilityGate(input),
    blindedAgreementGate(input),
    lowPowerGate(input, evidence),
  ];

  if (input.decisionPolicyMode === 'preregistered') {
    const delta = statistics.verifiedSuccessDelta;
    gates.push(
      gate(
        GATE_IDS.VERIFIED_SUCCESS_DELTA,
        delta !== null && delta >= decisionPolicy.verifiedSuccessDeltaMin ? 'passed' : 'failed',
        delta,
        `>= ${String(decisionPolicy.verifiedSuccessDeltaMin)}`,
        'Treatment verified success delta versus control',
        evidence,
      ),
      gate(
        GATE_IDS.PAIRED_IMPROVEMENT_SIGNIFICANCE,
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

/**
 * Fail-closed verdict: any `failed` gate → FAILED; otherwise any `insufficient_data` gate →
 * INSUFFICIENT_DATA; `warning` and `not_evaluated` never block PASSED.
 */
export function deriveVerdict(gates: readonly GateResult[]): ExperimentVerdict {
  if (gates.some((entry) => entry.status === 'failed')) {
    return 'FAILED';
  }
  if (gates.some((entry) => entry.status === 'insufficient_data')) {
    return 'INSUFFICIENT_DATA';
  }
  return 'PASSED';
}

/** Capability names from `suite.isolation.require` whose value is `true`. */
export function requiredCapabilityNames(require: SuiteDocument['isolation']['require']): string[] {
  return ISOLATION_REQUIRE_KEYS.filter((name) => require[name] === true)
    .slice()
    .sort();
}

/** Required capabilities that `observed` did not record as enforced. */
export function unmetRequiredCapabilities(
  require: SuiteDocument['isolation']['require'],
  observed: IsolationCapabilities,
): string[] {
  return ISOLATION_REQUIRE_KEYS.filter((name) => require[name] === true && !observed[name])
    .slice()
    .sort();
}
