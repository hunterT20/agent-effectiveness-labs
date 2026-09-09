import { describe, expect, it } from 'vitest';

import { GATE_IDS } from '@ael/core';
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

  it('prints gate evidence paths and a LOW_POWER banner', () => {
    const report = buildReportSource({
      experimentId: 'exp-2',
      suiteName: 'minimal',
      verdict: 'INSUFFICIENT_DATA',
      gates: [
        {
          id: GATE_IDS.LOW_POWER,
          status: 'insufficient_data',
          actual: 2,
          expected: 'discordant pairs >= 5',
          message: 'LOW_POWER: discordant pairs 2 < minimum 5',
          evidencePaths: ['attempts', 'trial-plan.json'],
        },
      ],
      statistics: {
        independentFixtureCount: 3,
        trialCount: 6,
        pairedSignTest: {
          improvements: 2,
          regressions: 0,
          ties: 0,
          pValueOneSided: 0.25,
          pValueTwoSided: 0.5,
        },
        verifiedSuccessDelta: 0.5,
        controlVerifiedSuccessRate: 0,
        treatmentVerifiedSuccessRate: 0.5,
        controlMedianDurationMs: 100,
        treatmentMedianDurationMs: 120,
        controlP90DurationMs: 100,
        treatmentP90DurationMs: 120,
        controlP95DurationMs: 100,
        treatmentP95DurationMs: 120,
        infrastructureFailureRate: 0,
        powerReadiness: {
          version: 'power-readiness-v2',
          discordantPairs: 2,
          minimumDiscordantPairs: 5,
          independentFixtureCount: 3,
          minimumDetectableDelta: 0.2,
          lowPower: true,
          reasons: ['discordant pairs 2 < minimum 5'],
          fixtureWarning: null,
        },
        bootstrap: {
          method: 'percentile-cluster-resample',
          version: 'cluster-bootstrap-v2',
          statistic: 'mean',
          iterations: 200,
          confidenceLevel: 0.95,
          pointEstimate: 0.5,
          lower: 0,
          upper: 1,
          resampledFixtureCount: 3,
        },
        holm: {
          method: 'holm',
          version: 'holm-v2',
          alpha: 0.05,
          comparisons: [
            {
              id: 'arm-x',
              rawPValue: 0.01,
              adjustedPValue: 0.02,
              significant: true,
              rank: 1,
            },
          ],
        },
      },
      blindedAgreement: {
        evidencePath: 'blinded/agreement.json',
        method: 'cohen-kappa',
        kappa: 0.8,
        minimumKappa: 0.6,
        adequate: true,
        adjudicationComplete: true,
        raterCount: 2,
        packetCount: 4,
        ratedPacketCount: 4,
      },
    });
    const markdown = renderReportMarkdown(report);
    expect(markdown).toContain('**LOW_POWER**');
    expect(markdown).toContain('evidence: attempts, trial-plan.json');
    expect(markdown).toContain('cluster-bootstrap-v2');
    expect(markdown).toContain('holm-v2');
    expect(markdown).toContain('blinded/agreement.json');
    expect(serializeReportJson(report)).toContain('"statistic": "mean"');
  });
});
