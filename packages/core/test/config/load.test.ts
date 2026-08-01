import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadSuiteManifest } from '@ael/core';

const validSuiteYaml = `schemaVersion: 1
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

describe('loadSuiteManifest', () => {
  it('preserves source path and normalized value for audit', () => {
    const root = mkdtempSync(join(tmpdir(), 'ael-load-'));
    const suitePath = join(root, 'suite.yaml');
    writeFileSync(suitePath, validSuiteYaml, 'utf8');

    const loaded = loadSuiteManifest(suitePath);

    expect(loaded.sourcePath).toBe(suitePath);
    expect(loaded.normalizedValue.id).toBe('awh-effectiveness-v1');
    expect(loaded.normalizedValue.schemaVersion).toBe(1);
  });

  it('resolves referenced files relative to the declaring manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'ael-load-'));
    const suitePath = join(root, 'suite.yaml');
    writeFileSync(suitePath, validSuiteYaml, 'utf8');
    mkdirSync(join(root, 'arms'), { recursive: true });
    mkdirSync(join(root, 'fixtures/recover-after-failed-test'), { recursive: true });

    const loaded = loadSuiteManifest(suitePath);

    expect(loaded.references.arms[0]?.sourcePath).toBe(join(root, 'arms/baseline.yaml'));
    expect(loaded.references.fixtures[0]?.sourcePath).toBe(
      join(root, 'fixtures/recover-after-failed-test/fixture.yaml'),
    );
  });
});
