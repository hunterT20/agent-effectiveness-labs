import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DEFAULT_MINIMUM_DETECTABLE_DELTA,
  DEFAULT_MINIMUM_DISCORDANT_PAIRS,
  computeExperimentStatistics,
  deriveVerdict,
  evaluateGates,
  loadSuiteManifest,
  requiredCapabilityNames,
  unmetRequiredCapabilities,
} from '@ael/core';
import {
  buildReportSource,
  renderReportCsv,
  renderReportHtml,
  renderReportMarkdown,
  serializeReportJson,
} from '@ael/reporter';
import { collectExperimentResults, collectedTrialToMetric } from '@ael/runtime';

import { EXIT_OK, EXIT_RUNTIME, EXIT_VERDICT_FAIL } from '../exitCodes.js';
import type { CommandContext } from './index.js';

export type ReportFormat = 'json' | 'md' | 'csv' | 'html';

export interface ReportCommandOptions {
  readonly formats?: ReadonlyArray<ReportFormat>;
}

const DEFAULT_FORMATS: readonly ReportFormat[] = ['json', 'md', 'csv', 'html'];

function extensionFor(format: ReportFormat): string {
  return format === 'md' ? 'md' : format;
}

function renderFormat(format: ReportFormat, report: ReturnType<typeof buildReportSource>): string {
  switch (format) {
    case 'json':
      return serializeReportJson(report);
    case 'md':
      return renderReportMarkdown(report);
    case 'csv':
      return renderReportCsv(report);
    case 'html':
      return renderReportHtml(report);
  }
}

/**
 * Rebuild an experiment report from artifacts. Does not invoke an agent.
 *
 * Verdict is written to stdout; diagnostics to stderr.
 */
export async function reportCommand(
  outputRoot: string,
  suitePath: string,
  context: CommandContext,
  failOnVerdict = false,
  options?: ReportCommandOptions,
): Promise<number> {
  try {
    const loaded = loadSuiteManifest(suitePath);
    const suite = loaded.normalizedValue;
    const collected = await collectExperimentResults(outputRoot);

    const controlArm = collected.preregistration?.primaryControlArm ?? suite.primaryControlArm;
    const treatmentArm =
      collected.preregistration?.primaryTreatmentArm ?? suite.primaryTreatmentArm;
    const secondaryTreatmentArms = collected.trialPlan.comparisons.secondary.map(
      (entry) => entry.treatmentArm,
    );
    const randomSeed = collected.preregistration?.randomSeed ?? collected.trialPlan.randomSeed;

    const statistics = computeExperimentStatistics({
      controlArm,
      treatmentArm,
      trials: collected.trials.map(collectedTrialToMetric),
      randomSeed,
      multipleComparisonMethod: suite.decisionPolicy.multipleComparisonMethod,
      alpha: suite.decisionPolicy.pairedImprovementPValueMax,
      minimumDiscordantPairs:
        suite.decisionPolicy.minimumDiscordantPairs ?? DEFAULT_MINIMUM_DISCORDANT_PAIRS,
      minimumDetectableDelta:
        suite.decisionPolicy.minimumDetectableDelta ?? DEFAULT_MINIMUM_DETECTABLE_DELTA,
      plannedPairs: collected.trialPlan.counts.pairs,
      ...(secondaryTreatmentArms.length > 0 ? { secondaryTreatmentArms } : {}),
    });

    const safetyViolations = collected.trials
      .filter((trial) => trial.armId === treatmentArm && trial.safetyViolation)
      .map((trial) => ({
        trialId: trial.trialId,
        evidencePath: trial.evidencePaths.grade ?? trial.evidencePaths.state,
      }));

    const capabilityEvidence =
      collected.doctor === null
        ? null
        : {
            evidencePath: collected.doctor.evidencePath,
            unmetRequiredCapabilities: unmetRequiredCapabilities(
              suite.isolation.require,
              collected.doctor.observedCapabilities,
            ),
          };

    const gates = evaluateGates({
      decisionPolicy: suite.decisionPolicy,
      decisionPolicyMode: suite.decisionPolicy.mode,
      statistics,
      completedPairs: statistics.completedPairs,
      evidenceRoot: 'attempts',
      statisticsEvidencePaths: ['trial-plan.json', 'attempts'],
      safetyViolations,
      requiredCapabilities: requiredCapabilityNames(suite.isolation.require),
      capabilityEvidence,
      blindedAgreement: collected.blindedAgreement,
    });
    const verdict = deriveVerdict(gates);

    const report = buildReportSource({
      experimentId: suite.id,
      suiteName: suite.name,
      verdict,
      gates,
      statistics,
      blindedAgreement: collected.blindedAgreement,
      telemetryCoverage: collected.telemetryCoverage,
    });

    const formats = options?.formats ?? DEFAULT_FORMATS;
    const reportDir = join(outputRoot, 'report');
    await mkdir(reportDir, { recursive: true });
    for (const format of formats) {
      await writeFile(
        join(reportDir, `report.${extensionFor(format)}`),
        renderFormat(format, report),
        'utf8',
      );
    }

    for (const unresolved of collected.unresolvedAttempts) {
      context.stderr(
        `unresolved attempt ${unresolved.trialId}/${unresolved.attemptId}: ${unresolved.reason}\n`,
      );
    }
    if (statistics.powerReadiness.lowPower) {
      context.stderr(`LOW_POWER: ${statistics.powerReadiness.reasons.join('; ')}\n`);
    }

    context.stdout(`${verdict}\n`);
    if (failOnVerdict && verdict !== 'PASSED') {
      return EXIT_VERDICT_FAIL;
    }
    return EXIT_OK;
  } catch (error) {
    context.stderr(formatReportError(error));
    return EXIT_RUNTIME;
  }
}

function formatReportError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'report failed';
  }
  const cause = error.cause;
  if (cause instanceof Error && cause.message.length > 0 && cause.message !== error.message) {
    return `${error.message}: ${cause.message}`;
  }
  return error.message;
}
