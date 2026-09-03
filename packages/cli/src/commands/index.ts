import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  buildTrialPlan,
  computeFingerprint,
  deriveVerdict,
  evaluateGates,
  fingerprintRecord,
  loadSuiteManifest,
  parseArmDocument,
  parseFixtureDocument,
  sealPreregistration,
  serializePreregistration,
  serializeTrialPlan,
} from '@ael/core';
import { buildReportSource, renderReportMarkdown, serializeReportJson } from '@ael/reporter';
import {
  DirectoryOnlyIsolationProvider,
  createCustomCommandAdapter,
  registerAdapter,
  runExperiment,
} from '@ael/runtime';

import {
  EXIT_CAPABILITY,
  EXIT_CONFIG,
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_VERDICT_FAIL,
} from '../exitCodes.js';

export interface CommandContext {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

function readYamlFile(path: string): unknown {
  return parseYaml(readFileSync(path, 'utf8'));
}

export function validateSuiteCommand(suitePath: string, context: CommandContext): number {
  try {
    loadSuiteManifest(suitePath);
    context.stdout('suite valid\n');
    return EXIT_OK;
  } catch (error) {
    context.stderr(error instanceof Error ? error.message : 'suite validation failed');
    return EXIT_CONFIG;
  }
}

export function validateFixtureCommand(fixturePath: string, context: CommandContext): number {
  try {
    parseFixtureDocument(readYamlFile(fixturePath), fixturePath);
    context.stdout('fixture valid\n');
    return EXIT_OK;
  } catch (error) {
    context.stderr(error instanceof Error ? error.message : 'fixture validation failed');
    return EXIT_CONFIG;
  }
}

export function validateArmCommand(armPath: string, context: CommandContext): number {
  try {
    parseArmDocument(readYamlFile(armPath), armPath);
    context.stdout('arm valid\n');
    return EXIT_OK;
  } catch (error) {
    context.stderr(error instanceof Error ? error.message : 'arm validation failed');
    return EXIT_CONFIG;
  }
}

export async function doctorCommand(suitePath: string, context: CommandContext): Promise<number> {
  try {
    const loaded = loadSuiteManifest(suitePath);
    const isolation = new DirectoryOnlyIsolationProvider();
    const doctor = await isolation.doctor({
      requestedCapabilities: {
        filesystemEnforced: loaded.normalizedValue.isolation.require.filesystemEnforced ?? false,
        networkPolicyEnforced:
          loaded.normalizedValue.isolation.require.networkPolicyEnforced ?? false,
        processTreeEnforced: loaded.normalizedValue.isolation.require.processTreeEnforced ?? false,
        hiddenGraderProtected:
          loaded.normalizedValue.isolation.require.hiddenGraderProtected ?? false,
        externalArtifactsProtected:
          loaded.normalizedValue.isolation.require.externalArtifactsProtected ?? false,
      },
    });
    for (const message of doctor.messages) {
      context.stderr(`${message}\n`);
    }
    return doctor.supported ? EXIT_OK : EXIT_CAPABILITY;
  } catch (error) {
    context.stderr(error instanceof Error ? error.message : 'doctor failed');
    return EXIT_CONFIG;
  }
}

export function planCommand(
  suitePath: string,
  outputRoot: string,
  context: CommandContext,
  json = false,
): number {
  try {
    const loaded = loadSuiteManifest(suitePath);
    const suite = loaded.normalizedValue;
    const fixtureIds: string[] = [];
    let phasesPerFixture = 1;
    for (const fixturePath of suite.fixtures) {
      const fixture = parseFixtureDocument(
        readYamlFile(join(loaded.manifestDir, fixturePath)),
        fixturePath,
      );
      fixtureIds.push(fixture.id);
      phasesPerFixture = Math.max(phasesPerFixture, fixture.phases.length);
    }
    const armIds = suite.arms.map((armPath) => {
      const arm = parseArmDocument(readYamlFile(join(loaded.manifestDir, armPath)), armPath);
      return arm.id;
    });
    const trialPlan = buildTrialPlan({
      fixtureIds,
      armIds,
      repeats: suite.defaults.repeats,
      randomSeed: suite.defaults.randomSeed,
      primaryControlArm: suite.primaryControlArm,
      primaryTreatmentArm: suite.primaryTreatmentArm,
      timeoutMs: suite.defaults.timeoutMs,
      phasesPerFixture,
    });
    const suiteFingerprint = fingerprintRecord('suite', 1, suite);
    const preregistration = sealPreregistration({
      suiteFingerprint,
      trialPlan,
      primaryControlArm: suite.primaryControlArm,
      primaryTreatmentArm: suite.primaryTreatmentArm,
      decisionPolicyMode: suite.decisionPolicy.mode,
    });
    mkdirSync(outputRoot, { recursive: true });
    writeFileSync(join(outputRoot, 'trial-plan.json'), serializeTrialPlan(trialPlan), 'utf8');
    writeFileSync(
      join(outputRoot, 'preregistration.json'),
      serializePreregistration(preregistration),
      'utf8',
    );
    if (json) {
      context.stdout(
        `${JSON.stringify({ suiteFingerprint, trialPlan, preregistration }, null, 2)}\n`,
      );
    } else {
      context.stdout(`planned ${String(trialPlan.counts.trials)} trials\n`);
    }
    return EXIT_OK;
  } catch (error) {
    context.stderr(error instanceof Error ? error.message : 'plan failed');
    return EXIT_CONFIG;
  }
}

export async function runCommand(
  suitePath: string,
  outputRoot: string,
  fakeAgentPath: string,
  context: CommandContext,
): Promise<number> {
  try {
    const loaded = loadSuiteManifest(suitePath);
    const suite = loaded.normalizedValue;
    const adapter = createCustomCommandAdapter('fake-agent', {
      command: process.execPath,
      extraArgs: [fakeAgentPath],
      timeoutMs: suite.defaults.timeoutMs,
    });
    registerAdapter(adapter);
    const planCode = planCommand(suitePath, outputRoot, context);
    if (planCode !== EXIT_OK) {
      return planCode;
    }
    const trialPlan = JSON.parse(
      readFileSync(join(outputRoot, 'trial-plan.json'), 'utf8'),
    ) as import('@ael/core').TrialPlan;
    const preregistration = JSON.parse(
      readFileSync(join(outputRoot, 'preregistration.json'), 'utf8'),
    ) as import('@ael/core').Preregistration;

    const fixtures = new Map<
      string,
      { document: import('@ael/core').FixtureDocument; root: string }
    >();
    for (const fixturePath of suite.fixtures) {
      const sourcePath = join(loaded.manifestDir, fixturePath);
      const document = parseFixtureDocument(readYamlFile(sourcePath), sourcePath);
      fixtures.set(document.id, { document, root: dirname(sourcePath) });
    }
    const arms = new Map<string, { document: import('@ael/core').ArmDocument; path: string }>();
    for (const armPath of suite.arms) {
      const sourcePath = join(loaded.manifestDir, armPath);
      const document = parseArmDocument(readYamlFile(sourcePath), sourcePath);
      arms.set(document.id, { document, path: sourcePath });
    }

    const suiteFingerprint = fingerprintRecord('suite', 1, suite);
    const result = await runExperiment({
      experimentRoot: outputRoot,
      suite,
      suiteRoot: loaded.manifestDir,
      suiteFingerprint,
      trialPlan,
      preregistration,
      fixtures,
      arms,
      adapter,
      isolation: new DirectoryOnlyIsolationProvider(),
      sourceRepositoryPath: join(loaded.manifestDir, suite.repository.path),
      agentFingerprint: computeFingerprint(suite.agent),
      isolationFingerprint: computeFingerprint(suite.isolation),
      pricingFingerprint: 'unpriced',
    });
    context.stdout(`completed ${String(result.completedTrials)} trials\n`);
    return EXIT_OK;
  } catch (error) {
    context.stderr(error instanceof Error ? error.message : 'run failed');
    return EXIT_RUNTIME;
  }
}

export function statusCommand(outputRoot: string, context: CommandContext): number {
  try {
    const trialPlan = JSON.parse(
      readFileSync(join(outputRoot, 'trial-plan.json'), 'utf8'),
    ) as import('@ael/core').TrialPlan;
    context.stdout(`trials=${String(trialPlan.counts.trials)}\n`);
    return EXIT_OK;
  } catch (error) {
    context.stderr(error instanceof Error ? error.message : 'status failed');
    return EXIT_RUNTIME;
  }
}

export function resumeCommand(
  suitePath: string,
  outputRoot: string,
  fakeAgentPath: string,
  context: CommandContext,
): Promise<number> {
  return runCommand(suitePath, outputRoot, fakeAgentPath, context);
}

export function reportCommand(
  outputRoot: string,
  suitePath: string,
  context: CommandContext,
  failOnVerdict = false,
): number {
  try {
    const loaded = loadSuiteManifest(suitePath);
    const suite = loaded.normalizedValue;
    const gates = evaluateGates({
      decisionPolicy: suite.decisionPolicy,
      decisionPolicyMode: suite.decisionPolicy.mode,
      statistics: {
        independentFixtureCount: suite.fixtures.length,
        trialCount: 0,
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
      completedPairs: 0,
      evidenceRoot: outputRoot,
    });
    const verdict = deriveVerdict(gates);
    const report = buildReportSource({
      experimentId: suite.id,
      suiteName: suite.name,
      verdict,
      gates,
      statistics: {
        independentFixtureCount: suite.fixtures.length,
        trialCount: 0,
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
    mkdirSync(join(outputRoot, 'report'), { recursive: true });
    writeFileSync(join(outputRoot, 'report', 'report.json'), serializeReportJson(report), 'utf8');
    writeFileSync(join(outputRoot, 'report', 'report.md'), renderReportMarkdown(report), 'utf8');
    if (failOnVerdict && verdict !== 'PASSED') {
      return EXIT_VERDICT_FAIL;
    }
    context.stdout(`${verdict}\n`);
    return EXIT_OK;
  } catch (error) {
    context.stderr(error instanceof Error ? error.message : 'report failed');
    return EXIT_RUNTIME;
  }
}
