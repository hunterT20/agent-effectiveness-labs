import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import {
  buildReportSource,
  renderReportMarkdown,
  renderReportCsv,
  renderReportHtml,
  serializeReportJson,
} from '@ael/reporter';
import {
  AgentCliSandboxIsolationProvider,
  DirectoryOnlyIsolationProvider,
  createCustomCommandAdapter,
  createCursorAdapter,
  estimateAdvisoryExposure,
  fixtureRequiresResumeCapability,
  loadPricingSnapshot,
  pricingFingerprintForSuite,
  registerAdapter,
  resolveSuitePricingPath,
  runExperiment,
  runFixtureSelfTest,
  summarizeTelemetryCoverage,
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

function resolveAdapterForSuite(
  suite: import('@ael/core').SuiteDocument,
  timeoutMs: number,
  fakeAgentPath?: string,
): import('@ael/core').AgentAdapter {
  if (suite.agent.adapter === 'cursor') {
    return createCursorAdapter({
      model: suite.agent.model,
      timeoutMs,
      skipSandboxProbe: process.env.AEL_SKIP_SANDBOX_PROBE === '1',
    });
  }
  if (suite.agent.adapter === 'fake-agent') {
    return createCustomCommandAdapter('fake-agent', {
      command: process.execPath,
      extraArgs: [fakeAgentPath ?? ''],
      timeoutMs,
    });
  }
  return createCustomCommandAdapter(suite.agent.adapter, {
    command: suite.agent.adapter,
    timeoutMs,
  });
}

function resolveIsolationForSuite(
  suite: import('@ael/core').SuiteDocument,
  adapter: import('@ael/core').AgentAdapter,
): DirectoryOnlyIsolationProvider | AgentCliSandboxIsolationProvider {
  if (suite.isolation.provider === 'agent-cli-sandbox') {
    return new AgentCliSandboxIsolationProvider({
      adapter,
      model: suite.agent.model,
    });
  }
  return new DirectoryOnlyIsolationProvider();
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

export async function fixtureSelfTestCommand(
  fixturePath: string,
  context: CommandContext,
): Promise<number> {
  try {
    const fixture = parseFixtureDocument(readYamlFile(fixturePath), fixturePath);
    const fixtureRoot = dirname(fixturePath);
    const examplesRoot = join(fixtureRoot, '../../..');
    const suitePath = join(examplesRoot, 'suite.yaml');
    const loaded = loadSuiteManifest(suitePath);
    const workDir = mkdtempSync(join(tmpdir(), 'ael-fixture-self-test-'));
    const result = await runFixtureSelfTest({
      fixture,
      fixtureRoot,
      seedRepositoryPath: join(loaded.manifestDir, loaded.normalizedValue.repository.path),
      repositoryCommit: loaded.normalizedValue.repository.commit,
      workDir,
    });
    if (!result.valid) {
      for (const message of result.messages) {
        context.stderr(`${message}\n`);
      }
      return EXIT_CONFIG;
    }
    context.stdout('fixture self-test passed\n');
    return EXIT_OK;
  } catch (error) {
    context.stderr(error instanceof Error ? error.message : 'fixture self-test failed');
    return EXIT_RUNTIME;
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
    const suite = loaded.normalizedValue;
    const adapter = resolveAdapterForSuite(suite, suite.defaults.timeoutMs);
    registerAdapter(adapter);
    const isolation = resolveIsolationForSuite(suite, adapter);

    const agentDoctor = await adapter.doctor({
      workspaceRoot: loaded.manifestDir,
      model: suite.agent.model,
    });
    for (const message of agentDoctor.messages) {
      context.stderr(`${message}\n`);
    }

    const isolationDoctor = await isolation.doctor({
      requestedCapabilities: {
        filesystemEnforced: suite.isolation.require.filesystemEnforced ?? false,
        networkPolicyEnforced: suite.isolation.require.networkPolicyEnforced ?? false,
        processTreeEnforced: suite.isolation.require.processTreeEnforced ?? false,
        hiddenGraderProtected: suite.isolation.require.hiddenGraderProtected ?? false,
        externalArtifactsProtected: suite.isolation.require.externalArtifactsProtected ?? false,
      },
    });
    for (const message of isolationDoctor.messages) {
      context.stderr(`${message}\n`);
    }

    context.stdout(
      `agent=${suite.agent.adapter} model=${suite.agent.model} isolation=${suite.isolation.provider}\n`,
    );
    if (agentDoctor.version !== undefined) {
      context.stdout(`agent-version=${agentDoctor.version}\n`);
    }

    const ready = agentDoctor.ready && isolationDoctor.supported;
    if (!ready) {
      context.stderr('doctor: capability requirements not met\n');
    }
    if (suite.agent.adapter === 'cursor') {
      context.stderr(
        'Holdpoint B: live cursor-agent runs require explicit human approval after reviewing plan output\n',
      );
    }
    return ready ? EXIT_OK : EXIT_CAPABILITY;
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
    const adapter = resolveAdapterForSuite(suite, suite.defaults.timeoutMs);
    registerAdapter(adapter);

    const fixtureDocs: import('@ael/core').FixtureDocument[] = [];
    const fixtureIds: string[] = [];
    let phasesPerFixture = 1;
    for (const fixturePath of suite.fixtures) {
      const fixture = parseFixtureDocument(
        readYamlFile(join(loaded.manifestDir, fixturePath)),
        fixturePath,
      );
      fixtureDocs.push(fixture);
      fixtureIds.push(fixture.id);
      phasesPerFixture = Math.max(phasesPerFixture, fixture.phases.length);
    }

    if (fixtureRequiresResumeCapability(fixtureDocs) && adapter.capabilities?.resume !== true) {
      context.stderr(
        'plan failed: fixture requires session resume but adapter lacks capabilities.resume\n',
      );
      return EXIT_CONFIG;
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

    const pricingPath = resolveSuitePricingPath(loaded.manifestDir);
    const pricing =
      pricingPath !== null ? loadPricingSnapshot(loaded.manifestDir, pricingPath) : null;
    const advisoryCost = estimateAdvisoryExposure({
      trialPlanAgentInvocations: trialPlan.counts.agentInvocations,
      model: suite.agent.model,
      pricing,
      assumedInputTokensPerInvocation: 50_000,
      assumedOutputTokensPerInvocation: 10_000,
    });
    const fairnessWarnings: string[] = [];
    if (suite.defaults.concurrency > 1) {
      fairnessWarnings.push(
        `concurrency=${String(suite.defaults.concurrency)} may reduce causal fairness for paid runs`,
      );
    }
    if (suite.agent.adapter === 'cursor') {
      fairnessWarnings.push('live run requires explicit human approval (Holdpoint B)');
    }

    const planReport = {
      suiteFingerprint,
      trialPlan,
      preregistration,
      agent: {
        adapter: suite.agent.adapter,
        model: suite.agent.model,
        capabilities: adapter.capabilities ?? null,
      },
      isolation: suite.isolation,
      counts: trialPlan.counts,
      timeoutMs: suite.defaults.timeoutMs,
      concurrency: suite.defaults.concurrency,
      pricingFingerprint: pricing?.fingerprint ?? 'unpriced',
      advisoryCostUsd: advisoryCost,
      telemetryCoverageTemplate: summarizeTelemetryCoverage({
        inputTokens: {
          value: null,
          quality: 'unavailable',
          source: null,
          coverageReason: 'pre-run',
        },
        outputTokens: {
          value: null,
          quality: 'unavailable',
          source: null,
          coverageReason: 'pre-run',
        },
        cachedInputTokens: {
          value: null,
          quality: 'unavailable',
          source: null,
          coverageReason: 'pre-run',
        },
        reasoningTokens: {
          value: null,
          quality: 'unavailable',
          source: null,
          coverageReason: 'pre-run',
        },
        subagentTokens: {
          value: null,
          quality: 'unavailable',
          source: null,
          coverageReason: 'pre-run',
        },
        toolCalls: { value: null, quality: 'unavailable', source: null, coverageReason: 'pre-run' },
      }),
      fairnessWarnings,
      holdpointB: {
        liveRunAuthorized: false,
        message:
          'Live cursor-agent pilot requires explicit human approval after reviewing this plan output.',
      },
    };

    if (json) {
      context.stdout(`${JSON.stringify(planReport, null, 2)}\n`);
    } else {
      context.stdout(`planned ${String(trialPlan.counts.trials)} trials\n`);
      context.stdout(`agent-invocations=${String(trialPlan.counts.agentInvocations)}\n`);
      context.stdout(`timeout-ms=${String(suite.defaults.timeoutMs)}\n`);
      context.stdout(`model=${suite.agent.model}\n`);
      if (advisoryCost.value !== null) {
        context.stdout(
          `advisory-max-cost-usd=${advisoryCost.value.toFixed(4)} (${advisoryCost.quality})\n`,
        );
      } else {
        context.stdout(
          `advisory-max-cost-usd=unavailable (${advisoryCost.coverageReason ?? 'unknown'})\n`,
        );
      }
      for (const warning of fairnessWarnings) {
        context.stderr(`fairness-warning: ${warning}\n`);
      }
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
    if (suite.agent.adapter === 'cursor') {
      context.stderr('cursor live runs are not authorized without Holdpoint B approval\n');
      return EXIT_CAPABILITY;
    }
    const adapter = resolveAdapterForSuite(suite, suite.defaults.timeoutMs, fakeAgentPath);
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
      isolation: resolveIsolationForSuite(suite, adapter),
      sourceRepositoryPath: join(loaded.manifestDir, suite.repository.path),
      agentFingerprint: computeFingerprint(suite.agent),
      isolationFingerprint: computeFingerprint(suite.isolation),
      pricingFingerprint: pricingFingerprintForSuite(loaded.manifestDir),
      concurrency: suite.defaults.concurrency,
    });
    context.stdout(`completed ${String(result.completedTrials)} trials\n`);
    if (result.cancelled) {
      context.stderr('experiment interrupted; resume to continue\n');
    }
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
    writeFileSync(join(outputRoot, 'report', 'report.csv'), renderReportCsv(report), 'utf8');
    writeFileSync(join(outputRoot, 'report', 'report.html'), renderReportHtml(report), 'utf8');
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
