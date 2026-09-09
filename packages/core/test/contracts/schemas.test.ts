import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  AEL_ERROR_CODES,
  ConfigValidationError,
  GradeStatusSchema,
  MetricQualitySchema,
  TrialStatusSchema,
  parseArmDocument,
  parseFixtureDocument,
  parsePricingDocument,
  parseSuiteDocument,
} from '@ael/core';

const validSuiteYaml = `
schemaVersion: 1
id: awh-effectiveness-v1
name: AWH effectiveness

repository:
  type: local-git
  path: ./seed-repo
  commit: 0123456789abcdef0123456789abcdef01234567

agent:
  adapter: cursor
  model: composer-2.5
  reasoning: standard
  permissionMode: workspace-write

isolation:
  provider: agent-cli-sandbox
  require:
    filesystemEnforced: true
    hiddenGraderProtected: true
    externalArtifactsProtected: true
  network: inherit

defaults:
  repeats: 5
  concurrency: 1
  timeoutMs: 1800000
  randomSeed: awh-v1-preregistered
  cachePolicy: cold-isolated

primaryControlArm: baseline
primaryTreatmentArm: awh

arms:
  - ./arms/baseline.yaml
  - ./arms/awh.yaml

fixtures:
  - ./fixtures/recover-after-failed-test/fixture.yaml

decisionPolicy:
  minimumCompletedPairs: 20
  minimumIndependentFixtures: 20
  maximumInfrastructureFailureRate: 0.05
  verifiedSuccessDeltaMin: 0.10
  pairedImprovementPValueMax: 0.05
  multipleComparisonMethod: holm
  treatmentCriticalSafetyMax: 0
  treatmentStaleEvidenceAcceptedMax: 0
  treatmentRecoveryRateMin: 0.90
  treatmentFalseBlockRateMax: 0.05
  telemetryCoverageMin: 0.90
  treatmentToControlCostPerSuccessMaxRatio: 1.10
  treatmentToControlMedianDurationMaxRatio: 1.20
  treatmentToControlMedianTokensMaxRatio: 1.20
`;

const validArmYaml = `
schemaVersion: 1
id: baseline
name: Baseline arm
actions:
  - type: environment
    variables:
      AEL_ARM: baseline
`;

const validFixtureYaml = `
schemaVersion: 1
id: recover-after-failed-test
name: Recover after misleading intermediate evidence
category: recovery
outcomeMode: hybrid

phases:
  - id: initial
    promptFile: ./prompts/initial.md
    session: new
  - id: recovery
    promptFile: ./prompts/recovery.md
    session: resume

limits:
  timeoutMsPerPhase: 900000
  maxChangedFiles: 12

candidate:
  allowedPaths:
    - src/**
    - test/**
  forbiddenPaths:
    - grader/**
  requiredArtifacts:
    - id: final-report
      source: agent-final
      schema: ./schemas/final-report.schema.json

grading:
  deterministic:
    - id: hidden-tests
      command: pnpm
      args: [vitest, run, grader/hidden]
      required: true
  blindedRubric:
    enabled: false
    rubricFile: null
    minimumRaters: 0
    minimumAgreement: null
  llmJudge:
    role: disabled

reference:
  solutionPatch: ./reference/solution.patch
  artifactDirectory: ./reference/artifacts
  mutationCases:
    - ./mutations/false-green.patch
`;

const validPricingYaml = `
schemaVersion: 1
id: cursor-composer-2.5
provider: cursor
model: composer-2.5
currency: USD
effectiveAt: "2026-01-01T00:00:00.000Z"
rates:
  inputPerMillion: 3.0
  outputPerMillion: 15.0
  cachedInputPerMillion: 0.75
  reasoningPerMillion: null
  subagentPerMillion: null
`;

function parseYamlUnknown(source: string): unknown {
  return parseYaml(source);
}

describe('valid configuration documents', () => {
  it('parses a valid suite document', () => {
    const doc = parseSuiteDocument(parseYamlUnknown(validSuiteYaml), 'suite.yaml');
    expect(doc.id).toBe('awh-effectiveness-v1');
    expect(doc.arms).toHaveLength(2);
  });

  it('parses a valid arm document', () => {
    const doc = parseArmDocument(parseYamlUnknown(validArmYaml), 'arms/baseline.yaml');
    expect(doc.id).toBe('baseline');
  });

  it('parses a valid fixture document', () => {
    const doc = parseFixtureDocument(
      parseYamlUnknown(validFixtureYaml),
      'fixtures/recover-after-failed-test/fixture.yaml',
    );
    expect(doc.outcomeMode).toBe('hybrid');
  });

  it('parses a valid pricing document', () => {
    const doc = parsePricingDocument(parseYamlUnknown(validPricingYaml), 'pricing/cursor.yaml');
    expect(doc.currency).toBe('USD');
  });
});

describe('strict validation failures', () => {
  it('rejects unknown keys with file and field paths', () => {
    const source = validSuiteYaml.replace(
      'name: AWH effectiveness',
      'name: AWH effectiveness\nextra: true',
    );
    expect(() => parseSuiteDocument(parseYamlUnknown(source), 'suite.yaml')).toThrow(
      ConfigValidationError,
    );
    try {
      parseSuiteDocument(parseYamlUnknown(source), 'suite.yaml');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const validationError = error as ConfigValidationError;
      expect(validationError.filePath).toBe('suite.yaml');
      expect(validationError.fieldPath).toContain('extra');
      expect(validationError.code).toBe(AEL_ERROR_CODES.CONFIG_UNKNOWN_FIELD);
    }
  });

  it('rejects unsupported schema versions', () => {
    const source = validSuiteYaml.replace('schemaVersion: 1', 'schemaVersion: 99');
    expect(() => parseSuiteDocument(parseYamlUnknown(source), 'suite.yaml')).toThrow(
      ConfigValidationError,
    );
  });

  it('rejects duplicate phase IDs in fixtures', () => {
    const source = validFixtureYaml.replace('  - id: recovery', '  - id: initial');
    expect(() => parseFixtureDocument(parseYamlUnknown(source), 'fixture.yaml')).toThrow(
      ConfigValidationError,
    );
    try {
      parseFixtureDocument(parseYamlUnknown(source), 'fixture.yaml');
    } catch (error) {
      const validationError = error as ConfigValidationError;
      expect(validationError.code).toBe(AEL_ERROR_CODES.CONFIG_DUPLICATE_ID);
      expect(validationError.fieldPath).toContain('phases');
    }
  });

  it('rejects invalid decision-policy thresholds', () => {
    const source = validSuiteYaml.replace(
      'verifiedSuccessDeltaMin: 0.10',
      'verifiedSuccessDeltaMin: 1.5',
    );
    expect(() => parseSuiteDocument(parseYamlUnknown(source), 'suite.yaml')).toThrow(
      ConfigValidationError,
    );
  });

  it('rejects non-finite numbers in decision policy', () => {
    const source = validSuiteYaml.replace(
      'telemetryCoverageMin: 0.90',
      'telemetryCoverageMin: NaN',
    );
    expect(() => parseSuiteDocument(parseYamlUnknown(source), 'suite.yaml')).toThrow(
      ConfigValidationError,
    );
    try {
      parseSuiteDocument(parseYamlUnknown(source), 'suite.yaml');
    } catch (error) {
      const validationError = error as ConfigValidationError;
      expect(validationError.code).toBe(AEL_ERROR_CODES.CONFIG_NON_FINITE_NUMBER);
    }
  });

  it('rejects fixtures with no graders when blinded rubric and llm judge are disabled', () => {
    const source = validFixtureYaml.replace(
      '  deterministic:\n    - id: hidden-tests\n      command: pnpm\n      args: [vitest, run, grader/hidden]\n      required: true',
      '  deterministic: []',
    );
    expect(() => parseFixtureDocument(parseYamlUnknown(source), 'fixture.yaml')).toThrow(
      ConfigValidationError,
    );
    try {
      parseFixtureDocument(parseYamlUnknown(source), 'fixture.yaml');
    } catch (error) {
      const validationError = error as ConfigValidationError;
      expect(validationError.code).toBe(AEL_ERROR_CODES.CONFIG_MISSING_GRADER);
    }
  });

  it('rejects empty arms in suite documents', () => {
    const source = validSuiteYaml.replace(
      'arms:\n  - ./arms/baseline.yaml\n  - ./arms/awh.yaml',
      'arms: []',
    );
    expect(() => parseSuiteDocument(parseYamlUnknown(source), 'suite.yaml')).toThrow(
      ConfigValidationError,
    );
    try {
      parseSuiteDocument(parseYamlUnknown(source), 'suite.yaml');
    } catch (error) {
      const validationError = error as ConfigValidationError;
      expect(validationError.code).toBe(AEL_ERROR_CODES.CONFIG_EMPTY_ARMS);
    }
  });

  it('rejects invalid telemetry quality values', () => {
    expect(() => MetricQualitySchema.parse('approximate')).toThrow();
  });
});

describe('independent status dimensions', () => {
  it('keeps trial status and grade status as separate enums', () => {
    const trialStatuses = TrialStatusSchema.options;
    const gradeStatuses = GradeStatusSchema.options;
    expect(trialStatuses).not.toEqual(gradeStatuses);
    expect(trialStatuses).toContain('completed');
    expect(gradeStatuses).toContain('verified_success');
    expect(trialStatuses).not.toContain('verified_success');
    expect(gradeStatuses).not.toContain('completed');
  });
});

describe('fixture outcome mode consistency', () => {
  it('accepts repository mode without required artifacts', () => {
    const source = validFixtureYaml
      .replace('outcomeMode: hybrid', 'outcomeMode: repository')
      .replace(/  requiredArtifacts:[\s\S]*?grading:/, 'grading:');
    const doc = parseFixtureDocument(parseYamlUnknown(source), 'fixture.yaml');
    expect(doc.outcomeMode).toBe('repository');
  });

  it('rejects repository mode with required artifacts', () => {
    const source = validFixtureYaml.replace('outcomeMode: hybrid', 'outcomeMode: repository');
    expect(() => parseFixtureDocument(parseYamlUnknown(source), 'fixture.yaml')).toThrow(
      ConfigValidationError,
    );
  });

  it('accepts artifact mode without repository reference fields', () => {
    const source = validFixtureYaml
      .replace('outcomeMode: hybrid', 'outcomeMode: artifact')
      .replace('  solutionPatch: ./reference/solution.patch\n', '');
    const doc = parseFixtureDocument(parseYamlUnknown(source), 'fixture.yaml');
    expect(doc.outcomeMode).toBe('artifact');
  });

  it('rejects artifact mode without required artifacts', () => {
    const source = validFixtureYaml
      .replace('outcomeMode: hybrid', 'outcomeMode: artifact')
      .replace(/  requiredArtifacts:[\s\S]*?grading:/, 'grading:')
      .replace('  solutionPatch: ./reference/solution.patch\n', '')
      .replace('  artifactDirectory: ./reference/artifacts\n', '');
    expect(() => parseFixtureDocument(parseYamlUnknown(source), 'fixture.yaml')).toThrow(
      ConfigValidationError,
    );
  });

  it('rejects hybrid mode missing repository reference', () => {
    const source = validFixtureYaml.replace('  solutionPatch: ./reference/solution.patch\n', '');
    expect(() => parseFixtureDocument(parseYamlUnknown(source), 'fixture.yaml')).toThrow(
      ConfigValidationError,
    );
  });
});

describe('multi-phase and blinded-rubric policies', () => {
  it('requires the first phase to use a new session', () => {
    const source = validFixtureYaml.replace('session: new', 'session: resume');
    expect(() => parseFixtureDocument(parseYamlUnknown(source), 'fixture.yaml')).toThrow(
      ConfigValidationError,
    );
    try {
      parseFixtureDocument(parseYamlUnknown(source), 'fixture.yaml');
    } catch (error) {
      const validationError = error as ConfigValidationError;
      expect(validationError.fieldPath).toContain('phases[0].session');
    }
  });

  it('requires blinded rubric raters and agreement when enabled', () => {
    const source = validFixtureYaml
      .replace('enabled: false', 'enabled: true')
      .replace('rubricFile: null', 'rubricFile: ./rubric.md')
      .replace('minimumRaters: 0', 'minimumRaters: 2')
      .replace('minimumAgreement: null', 'minimumAgreement: 0.8');
    const doc = parseFixtureDocument(parseYamlUnknown(source), 'fixture.yaml');
    expect(doc.grading.blindedRubric.enabled).toBe(true);
  });

  it('rejects enabled blinded rubric without rubric file', () => {
    const source = validFixtureYaml
      .replace('enabled: false', 'enabled: true')
      .replace('minimumRaters: 0', 'minimumRaters: 2')
      .replace('minimumAgreement: null', 'minimumAgreement: 0.8');
    expect(() => parseFixtureDocument(parseYamlUnknown(source), 'fixture.yaml')).toThrow(
      ConfigValidationError,
    );
  });
});
