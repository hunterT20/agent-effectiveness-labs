import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT_OK, EXIT_RUNTIME, EXIT_VERDICT_FAIL } from '../src/exitCodes.js';
import { reportCommand } from '../src/commands/report.js';
import { writeSyntheticExperiment } from '../../runtime/test/artifacts/syntheticExperiment.js';

function writeSuite(root: string, mode: 'exploratory' | 'preregistered'): string {
  const suitePath = join(root, 'suite.yaml');
  writeFileSync(
    suitePath,
    `schemaVersion: 1
id: synth-report
name: Synthetic report
repository:
  type: local-git
  path: ./seed
  commit: 0123456789abcdef0123456789abcdef01234567
agent:
  adapter: fake-agent
  model: fake
  reasoning: standard
  permissionMode: workspace-write
isolation:
  provider: directory-only
  require: {}
  network: deny
defaults:
  repeats: 2
  concurrency: 1
  timeoutMs: 1000
  randomSeed: synth-seed
  cachePolicy: cold-isolated
primaryControlArm: baseline
primaryTreatmentArm: treatment
arms:
  - ./arms/baseline.yaml
  - ./arms/treatment.yaml
fixtures:
  - ./fixtures/bug-fix.yaml
  - ./fixtures/regression.yaml
  - ./fixtures/claims-done.yaml
decisionPolicy:
  mode: ${mode}
  minimumCompletedPairs: 1
  minimumIndependentFixtures: 1
  maximumInfrastructureFailureRate: 1
  verifiedSuccessDeltaMin: 0
  pairedImprovementPValueMax: 1
  multipleComparisonMethod: none
  treatmentCriticalSafetyMax: 0
  treatmentStaleEvidenceAcceptedMax: 1
  treatmentRecoveryRateMin: 0
  treatmentFalseBlockRateMax: 1
  telemetryCoverageMin: 0
  treatmentToControlCostPerSuccessMaxRatio: 1
  treatmentToControlMedianDurationMaxRatio: 10
  treatmentToControlMedianTokensMaxRatio: 10
`,
    'utf8',
  );
  return suitePath;
}

function capture(): { stdout: string[]; stderr: string[]; context: { stdout: (m: string) => void; stderr: (m: string) => void } } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    context: {
      stdout: (message: string) => {
        stdout.push(message);
      },
      stderr: (message: string) => {
        stderr.push(message);
      },
    },
  };
}

describe('reportCommand', () => {
  it('writes report.json with collected trials and sign-test counts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ael-report-'));
    writeSyntheticExperiment(root);
    const suitePath = writeSuite(root, 'exploratory');
    const io = capture();

    const code = await reportCommand(root, suitePath, io.context);

    expect(code).toBe(EXIT_OK);
    expect(io.stdout.join('')).toBe('PASSED\n');
    expect(io.stderr.join('')).toContain('LOW_POWER');

    const reportRaw = JSON.parse(readFileSync(join(root, 'report', 'report.json'), 'utf8')) as {
      verdict: string;
      statistics: {
        trialCount: number;
        completedPairs: number;
        pairedSignTest: { improvements: number; regressions: number; ties: number };
        powerReadiness: { lowPower: boolean };
      };
      gates: Array<{ id: string; status: string; evidencePaths: string[] }>;
    };
    expect(reportRaw.verdict).toBe('PASSED');
    expect(reportRaw.statistics.trialCount).toBe(11);
    expect(reportRaw.statistics.completedPairs).toBe(4);
    expect(reportRaw.statistics.pairedSignTest).toMatchObject({
      improvements: 2,
      regressions: 0,
      ties: 2,
    });
    expect(reportRaw.statistics.powerReadiness.lowPower).toBe(true);
    expect(reportRaw.gates.some((gate) => gate.id === 'LOW_POWER' && gate.status === 'warning')).toBe(
      true,
    );
    expect(reportRaw.gates.every((gate) => Array.isArray(gate.evidencePaths))).toBe(true);
    expect(existsSync(join(root, 'report', 'report.md'))).toBe(true);
    expect(readFileSync(join(root, 'report', 'report.md'), 'utf8')).toContain('**LOW_POWER**');
  });

  it('forces INSUFFICIENT_DATA for LOW_POWER in preregistered mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ael-report-pre-'));
    writeSyntheticExperiment(root);
    const suitePath = writeSuite(root, 'preregistered');
    const io = capture();

    const code = await reportCommand(root, suitePath, io.context, true);

    expect(code).toBe(EXIT_VERDICT_FAIL);
    expect(io.stdout.join('')).toBe('INSUFFICIENT_DATA\n');
  });

  it('honors format selection and returns EXIT_RUNTIME on missing artifacts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ael-report-fmt-'));
    writeSyntheticExperiment(root);
    const suitePath = writeSuite(root, 'exploratory');
    const io = capture();

    const code = await reportCommand(root, suitePath, io.context, false, { formats: ['json'] });
    expect(code).toBe(EXIT_OK);
    expect(existsSync(join(root, 'report', 'report.json'))).toBe(true);
    expect(existsSync(join(root, 'report', 'report.md'))).toBe(false);

    const missing = mkdtempSync(join(tmpdir(), 'ael-report-missing-'));
    const missingIo = capture();
    const missingCode = await reportCommand(missing, suitePath, missingIo.context);
    expect(missingCode).toBe(EXIT_RUNTIME);
    expect(missingIo.stderr.join('')).toContain('trial-plan.json');
  });
});
