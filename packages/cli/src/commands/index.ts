import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  buildTrialPlan,
  computeFingerprint,
  ConfigValidationError,
  deriveVerdict,
  evaluateGates,
  fingerprintRecord,
  loadSuiteManifest,
  parseArmDocument,
  parseFixtureDocument,
  PreregistrationSchema,
  sealPreregistration,
  serializePreregistration,
  serializeTrialPlan,
  TrialPlanSchema,
  TrialStatusSchema,
  type FixtureDocument,
  type IsolationCapabilities,
  type IsolationProvider,
  type LoadedSuiteManifest,
  type Preregistration,
  type SuiteDocument,
  type TrialPlan,
  type TrialStatus,
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
  ContainerIsolationProvider,
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

export interface RunCommandOptions {
  readonly approveLiveRun?: boolean;
}

export interface DoctorCommandOptions {
  readonly out?: string;
}

export interface LiveApprovalRecord {
  readonly approvedAt: string;
  readonly approvedBy: string;
  readonly method: 'flag' | 'env';
}

function readYamlFile(path: string): unknown {
  return parseYaml(readFileSync(path, 'utf8'));
}

function parseJsonFile(path: string): unknown {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return raw;
}

function printCaughtError(error: unknown, context: CommandContext, fallback: string): void {
  if (error instanceof ConfigValidationError) {
    for (const issue of error.issues) {
      context.stderr(`${issue.fieldPath} ${issue.code} ${issue.message}\n`);
    }
    return;
  }
  if (error instanceof Error) {
    context.stderr(`${error.message}\n`);
    return;
  }
  context.stderr(`${fallback}\n`);
}

function resolveAdapterForSuite(
  suite: SuiteDocument,
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
  suite: SuiteDocument,
  adapter: import('@ael/core').AgentAdapter,
  outputRoot?: string,
): IsolationProvider {
  if (suite.isolation.provider === 'container') {
    return new ContainerIsolationProvider({
      denyNetwork: suite.isolation.network === 'deny',
      ...(outputRoot !== undefined ? { artifactRoot: outputRoot } : {}),
    });
  }
  if (suite.isolation.provider === 'agent-cli-sandbox') {
    return new AgentCliSandboxIsolationProvider({
      adapter,
      model: suite.agent.model,
    });
  }
  return new DirectoryOnlyIsolationProvider();
}

function requestedIsolationCapabilities(suite: SuiteDocument): Partial<IsolationCapabilities> {
  return {
    filesystemEnforced: suite.isolation.require.filesystemEnforced ?? false,
    networkPolicyEnforced: suite.isolation.require.networkPolicyEnforced ?? false,
    processTreeEnforced: suite.isolation.require.processTreeEnforced ?? false,
    hiddenGraderProtected: suite.isolation.require.hiddenGraderProtected ?? false,
    externalArtifactsProtected: suite.isolation.require.externalArtifactsProtected ?? false,
  };
}

function loadFixtureDocuments(
  loaded: LoadedSuiteManifest,
  suite: SuiteDocument,
): FixtureDocument[] {
  const fixtureDocs: FixtureDocument[] = [];
  for (const fixturePath of suite.fixtures) {
    fixtureDocs.push(
      parseFixtureDocument(readYamlFile(join(loaded.manifestDir, fixturePath)), fixturePath),
    );
  }
  return fixtureDocs;
}

function fairnessWarningsFor(suite: SuiteDocument): string[] {
  const warnings: string[] = [];
  if (suite.defaults.concurrency > 1) {
    warnings.push(
      `concurrency=${String(suite.defaults.concurrency)} may reduce causal fairness for paid runs`,
    );
  }
  if (suite.agent.adapter === 'cursor') {
    warnings.push('live run requires explicit human approval (Holdpoint B)');
  }
  return warnings;
}

interface AssembledPlan {
  readonly loaded: LoadedSuiteManifest;
  readonly suite: SuiteDocument;
  readonly adapter: import('@ael/core').AgentAdapter;
  readonly fixtureDocs: FixtureDocument[];
  readonly trialPlan: TrialPlan;
  readonly preregistration: Preregistration;
  readonly resumeRequired: boolean;
  readonly resumeSupported: boolean;
  readonly advisoryCost: ReturnType<typeof estimateAdvisoryExposure>;
  readonly fairnessWarnings: string[];
  readonly pricingFingerprint: string;
  readonly suiteFingerprint: string;
}

function assemblePlan(suitePath: string, fakeAgentPath?: string): AssembledPlan {
  const loaded = loadSuiteManifest(suitePath);
  const suite = loaded.normalizedValue;
  const adapter = resolveAdapterForSuite(suite, suite.defaults.timeoutMs, fakeAgentPath);
  registerAdapter(adapter);
  const fixtureDocs = loadFixtureDocuments(loaded, suite);
  const resumeRequired = fixtureRequiresResumeCapability(fixtureDocs);
  const resumeSupported = adapter.capabilities?.resume === true;

  const fixtureIds = fixtureDocs.map((fixture) => fixture.id);
  let phasesPerFixture = 1;
  for (const fixture of fixtureDocs) {
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
  const pricingPath = resolveSuitePricingPath(loaded.manifestDir);
  const pricing =
    pricingPath !== null ? loadPricingSnapshot(loaded.manifestDir, pricingPath) : null;
  return {
    loaded,
    suite,
    adapter,
    fixtureDocs,
    trialPlan,
    preregistration,
    resumeRequired,
    resumeSupported,
    advisoryCost: estimateAdvisoryExposure({
      trialPlanAgentInvocations: trialPlan.counts.agentInvocations,
      model: suite.agent.model,
      pricing,
      assumedInputTokensPerInvocation: 50_000,
      assumedOutputTokensPerInvocation: 10_000,
    }),
    fairnessWarnings: fairnessWarningsFor(suite),
    pricingFingerprint: pricing?.fingerprint ?? 'unpriced',
    suiteFingerprint,
  };
}

function loadFixturesAndArms(
  loaded: LoadedSuiteManifest,
  suite: SuiteDocument,
): {
  readonly fixtures: Map<string, { document: FixtureDocument; root: string }>;
  readonly arms: Map<string, { document: import('@ael/core').ArmDocument; path: string }>;
} {
  const fixtures = new Map<string, { document: FixtureDocument; root: string }>();
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
  return { fixtures, arms };
}

export function loadSealedTrialPlan(outputRoot: string): TrialPlan {
  return TrialPlanSchema.parse(parseJsonFile(join(outputRoot, 'trial-plan.json')));
}

export function loadSealedPreregistration(outputRoot: string): Preregistration {
  return PreregistrationSchema.parse(parseJsonFile(join(outputRoot, 'preregistration.json')));
}

function approvalUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

export function writeLiveApprovalJson(
  outputRoot: string,
  method: 'flag' | 'env',
): LiveApprovalRecord {
  mkdirSync(outputRoot, { recursive: true });
  const record: LiveApprovalRecord = {
    approvedAt: new Date().toISOString(),
    approvedBy: approvalUsername(),
    method,
  };
  writeFileSync(join(outputRoot, 'live-approval.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

function requireLiveApproval(
  suite: SuiteDocument,
  outputRoot: string,
  context: CommandContext,
  options: RunCommandOptions,
): number | null {
  if (suite.agent.adapter !== 'cursor') {
    return null;
  }
  const flagApproved = options.approveLiveRun === true;
  const envApproved = process.env.AEL_APPROVE_LIVE_RUN === '1';
  if (!flagApproved && !envApproved) {
    context.stderr(
      'cursor live runs require --approve-live-run or AEL_APPROVE_LIVE_RUN=1 after reviewing `ael plan` (Holdpoint B)\n',
    );
    return EXIT_CAPABILITY;
  }
  writeLiveApprovalJson(outputRoot, flagApproved ? 'flag' : 'env');
  return null;
}

interface AttemptStateSummary {
  readonly trialId: string;
  readonly attemptId: string;
  readonly status: TrialStatus;
}

function parseAttemptState(raw: unknown, trialId: string, attemptId: string): AttemptStateSummary {
  if (typeof raw !== 'object' || raw === null || !('status' in raw)) {
    throw new Error(`invalid attempt state for ${trialId}/${attemptId}`);
  }
  const status = TrialStatusSchema.parse(raw.status);
  const recordedTrialId =
    'trialId' in raw && typeof raw.trialId === 'string' && raw.trialId.length > 0
      ? raw.trialId
      : trialId;
  const recordedAttemptId =
    'attemptId' in raw && typeof raw.attemptId === 'string' && raw.attemptId.length > 0
      ? raw.attemptId
      : attemptId;
  return { trialId: recordedTrialId, attemptId: recordedAttemptId, status };
}

export function scanAttemptStates(outputRoot: string): AttemptStateSummary[] {
  const attemptsRoot = join(outputRoot, 'attempts');
  let trialDirs: string[];
  try {
    trialDirs = readdirSync(attemptsRoot);
  } catch {
    return [];
  }
  const latestByTrial = new Map<string, AttemptStateSummary>();
  for (const trialId of trialDirs) {
    const trialDir = join(attemptsRoot, trialId);
    let attemptDirs: string[];
    try {
      attemptDirs = readdirSync(trialDir);
    } catch {
      continue;
    }
    const sortedAttempts = [...attemptDirs].sort();
    for (const attemptId of sortedAttempts) {
      try {
        const raw = parseJsonFile(join(trialDir, attemptId, 'state.json'));
        latestByTrial.set(trialId, parseAttemptState(raw, trialId, attemptId));
      } catch {
        continue;
      }
    }
  }
  return [...latestByTrial.values()];
}

export function validateSuiteCommand(suitePath: string, context: CommandContext): number {
  try {
    loadSuiteManifest(suitePath);
    context.stdout('suite valid\n');
    return EXIT_OK;
  } catch (error) {
    printCaughtError(error, context, 'suite validation failed');
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
    printCaughtError(error, context, 'fixture self-test failed');
    return EXIT_RUNTIME;
  }
}

export function validateFixtureCommand(fixturePath: string, context: CommandContext): number {
  try {
    parseFixtureDocument(readYamlFile(fixturePath), fixturePath);
    context.stdout('fixture valid\n');
    return EXIT_OK;
  } catch (error) {
    printCaughtError(error, context, 'fixture validation failed');
    return EXIT_CONFIG;
  }
}

export function validateArmCommand(armPath: string, context: CommandContext): number {
  try {
    parseArmDocument(readYamlFile(armPath), armPath);
    context.stdout('arm valid\n');
    return EXIT_OK;
  } catch (error) {
    printCaughtError(error, context, 'arm validation failed');
    return EXIT_CONFIG;
  }
}

export async function doctorCommand(
  suitePath: string,
  context: CommandContext,
  options: DoctorCommandOptions = {},
): Promise<number> {
  try {
    const assembled = assemblePlan(suitePath);
    const isolation = resolveIsolationForSuite(assembled.suite, assembled.adapter, options.out);
    const requested = requestedIsolationCapabilities(assembled.suite);

    const agentDoctor = await assembled.adapter.doctor({
      workspaceRoot: assembled.loaded.manifestDir,
      model: assembled.suite.agent.model,
    });
    for (const message of agentDoctor.messages) {
      context.stderr(`${message}\n`);
    }

    const isolationDoctor = await isolation.doctor({ requestedCapabilities: requested });
    for (const message of isolationDoctor.messages) {
      context.stderr(`${message}\n`);
    }

    if (assembled.resumeRequired && !assembled.resumeSupported) {
      context.stderr(
        'doctor: fixture requires session resume but adapter lacks capabilities.resume\n',
      );
    }

    context.stderr(`model=${assembled.suite.agent.model}\n`);
    context.stderr(`agent-version=${agentDoctor.version ?? 'unavailable'}\n`);
    context.stderr(`trials=${String(assembled.trialPlan.counts.trials)}\n`);
    context.stderr(`timeout-ms=${String(assembled.suite.defaults.timeoutMs)}\n`);
    if (assembled.advisoryCost.value !== null) {
      context.stderr(
        `advisory-max-cost-usd=${assembled.advisoryCost.value.toFixed(4)} (${assembled.advisoryCost.quality})\n`,
      );
    } else {
      context.stderr(
        `advisory-max-cost-usd=unavailable (${assembled.advisoryCost.coverageReason ?? 'unknown'})\n`,
      );
    }
    for (const warning of assembled.fairnessWarnings) {
      context.stderr(`fairness-warning: ${warning}\n`);
    }
    context.stderr(`requested-capabilities=${JSON.stringify(requested)}\n`);
    context.stderr(
      `observed-capabilities=${JSON.stringify(isolationDoctor.observedCapabilities)}\n`,
    );

    context.stdout(
      `agent=${assembled.suite.agent.adapter} model=${assembled.suite.agent.model} isolation=${assembled.suite.isolation.provider}\n`,
    );
    if (agentDoctor.version !== undefined) {
      context.stdout(`agent-version=${agentDoctor.version}\n`);
    }

    const ready =
      agentDoctor.ready &&
      isolationDoctor.supported &&
      !(assembled.resumeRequired && !assembled.resumeSupported);

    if (options.out !== undefined) {
      mkdirSync(options.out, { recursive: true });
      writeFileSync(
        join(options.out, 'doctor.json'),
        `${JSON.stringify(
          {
            ready,
            model: assembled.suite.agent.model,
            adapter: assembled.suite.agent.adapter,
            version: agentDoctor.version ?? null,
            trialCount: assembled.trialPlan.counts.trials,
            timeoutMs: assembled.suite.defaults.timeoutMs,
            advisoryCost: assembled.advisoryCost,
            fairnessWarnings: assembled.fairnessWarnings,
            requestedCapabilities: requested,
            observedCapabilities: isolationDoctor.observedCapabilities,
            agentMessages: agentDoctor.messages,
            isolationMessages: isolationDoctor.messages,
          },
          null,
          2,
        )}\n`,
      );
    }

    if (!ready) {
      context.stderr('doctor: capability requirements not met\n');
    }
    if (assembled.suite.agent.adapter === 'cursor') {
      context.stderr(
        'Holdpoint B: live cursor-agent runs require explicit human approval after reviewing plan output\n',
      );
    }
    return ready ? EXIT_OK : EXIT_CAPABILITY;
  } catch (error) {
    printCaughtError(error, context, 'doctor failed');
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
    const assembled = assemblePlan(suitePath);
    if (assembled.resumeRequired && !assembled.resumeSupported) {
      context.stderr(
        'plan failed: fixture requires session resume but adapter lacks capabilities.resume\n',
      );
      return EXIT_CAPABILITY;
    }

    mkdirSync(outputRoot, { recursive: true });
    writeFileSync(
      join(outputRoot, 'trial-plan.json'),
      serializeTrialPlan(assembled.trialPlan),
      'utf8',
    );
    writeFileSync(
      join(outputRoot, 'preregistration.json'),
      serializePreregistration(assembled.preregistration),
      'utf8',
    );

    const planReport = {
      suiteFingerprint: assembled.suiteFingerprint,
      trialPlan: assembled.trialPlan,
      preregistration: assembled.preregistration,
      agent: {
        adapter: assembled.suite.agent.adapter,
        model: assembled.suite.agent.model,
        capabilities: assembled.adapter.capabilities ?? null,
      },
      isolation: assembled.suite.isolation,
      counts: assembled.trialPlan.counts,
      timeoutMs: assembled.suite.defaults.timeoutMs,
      concurrency: assembled.suite.defaults.concurrency,
      pricingFingerprint: assembled.pricingFingerprint,
      advisoryCostUsd: assembled.advisoryCost,
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
      fairnessWarnings: assembled.fairnessWarnings,
      holdpointB: {
        liveRunAuthorized: false,
        message:
          'Live cursor-agent pilot requires explicit human approval after reviewing this plan output.',
      },
    };

    if (json) {
      context.stdout(`${JSON.stringify(planReport, null, 2)}\n`);
    } else {
      context.stdout(`planned ${String(assembled.trialPlan.counts.trials)} trials\n`);
      context.stdout(`agent-invocations=${String(assembled.trialPlan.counts.agentInvocations)}\n`);
      context.stdout(`timeout-ms=${String(assembled.suite.defaults.timeoutMs)}\n`);
      context.stdout(`model=${assembled.suite.agent.model}\n`);
      if (assembled.advisoryCost.value !== null) {
        context.stdout(
          `advisory-max-cost-usd=${assembled.advisoryCost.value.toFixed(4)} (${assembled.advisoryCost.quality})\n`,
        );
      } else {
        context.stdout(
          `advisory-max-cost-usd=unavailable (${assembled.advisoryCost.coverageReason ?? 'unknown'})\n`,
        );
      }
      for (const warning of assembled.fairnessWarnings) {
        context.stderr(`fairness-warning: ${warning}\n`);
      }
    }
    return EXIT_OK;
  } catch (error) {
    printCaughtError(error, context, 'plan failed');
    return EXIT_CONFIG;
  }
}

export async function runCommand(
  suitePath: string,
  outputRoot: string,
  fakeAgentPath: string,
  context: CommandContext,
  options: RunCommandOptions = {},
): Promise<number> {
  let assembled: AssembledPlan;
  let trialPlan: TrialPlan;
  let preregistration: Preregistration;
  let fixtures: Map<string, { document: FixtureDocument; root: string }>;
  let arms: Map<string, { document: import('@ael/core').ArmDocument; path: string }>;
  try {
    assembled = assemblePlan(suitePath, fakeAgentPath);
    const approvalCode = requireLiveApproval(assembled.suite, outputRoot, context, options);
    if (approvalCode !== null) {
      return approvalCode;
    }
    const planCode = planCommand(suitePath, outputRoot, context);
    if (planCode !== EXIT_OK) {
      return planCode;
    }
    trialPlan = loadSealedTrialPlan(outputRoot);
    preregistration = loadSealedPreregistration(outputRoot);
    ({ fixtures, arms } = loadFixturesAndArms(assembled.loaded, assembled.suite));
  } catch (error) {
    printCaughtError(error, context, 'run failed');
    return EXIT_CONFIG;
  }

  try {
    const result = await runExperiment({
      experimentRoot: outputRoot,
      suite: assembled.suite,
      suiteRoot: assembled.loaded.manifestDir,
      suiteFingerprint: assembled.suiteFingerprint,
      trialPlan,
      preregistration,
      fixtures,
      arms,
      adapter: assembled.adapter,
      isolation: resolveIsolationForSuite(assembled.suite, assembled.adapter, outputRoot),
      sourceRepositoryPath: join(assembled.loaded.manifestDir, assembled.suite.repository.path),
      agentFingerprint: computeFingerprint(assembled.suite.agent),
      isolationFingerprint: computeFingerprint(assembled.suite.isolation),
      pricingFingerprint: pricingFingerprintForSuite(assembled.loaded.manifestDir),
      concurrency: assembled.suite.defaults.concurrency,
    });
    context.stdout(`completed ${String(result.completedTrials)} trials\n`);
    if (result.cancelled) {
      context.stderr('experiment interrupted; resume to continue\n');
    }
    return EXIT_OK;
  } catch (error) {
    printCaughtError(error, context, 'run failed');
    return EXIT_RUNTIME;
  }
}

export function statusCommand(outputRoot: string, context: CommandContext, json = false): number {
  try {
    const trialPlan = loadSealedTrialPlan(outputRoot);
    const attempts = scanAttemptStates(outputRoot);
    const byStatus: Record<TrialStatus, number> = {
      pending: 0,
      preparing: 0,
      running: 0,
      collecting: 0,
      grading: 0,
      completed: 0,
      agent_failed: 0,
      timed_out: 0,
      infrastructure_failed: 0,
      cancelled: 0,
    };
    for (const attempt of attempts) {
      byStatus[attempt.status] += 1;
    }
    const payload = {
      plannedTrials: trialPlan.counts.trials,
      attemptCount: attempts.length,
      byStatus,
      attempts,
    };
    if (json) {
      context.stdout(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      context.stderr(`planned-trials=${String(trialPlan.counts.trials)}\n`);
      context.stderr(`attempts=${String(attempts.length)}\n`);
      for (const status of TrialStatusSchema.options) {
        context.stderr(`${status}=${String(byStatus[status])}\n`);
      }
    }
    return EXIT_OK;
  } catch (error) {
    printCaughtError(error, context, 'status failed');
    return EXIT_CONFIG;
  }
}

export async function resumeCommand(
  suitePath: string,
  outputRoot: string,
  fakeAgentPath: string,
  context: CommandContext,
  options: RunCommandOptions = {},
): Promise<number> {
  let assembled: AssembledPlan;
  let trialPlan: TrialPlan;
  let preregistration: Preregistration;
  let fixtures: Map<string, { document: FixtureDocument; root: string }>;
  let arms: Map<string, { document: import('@ael/core').ArmDocument; path: string }>;
  try {
    assembled = assemblePlan(suitePath, fakeAgentPath);
    const approvalCode = requireLiveApproval(assembled.suite, outputRoot, context, options);
    if (approvalCode !== null) {
      return approvalCode;
    }
    trialPlan = loadSealedTrialPlan(outputRoot);
    preregistration = loadSealedPreregistration(outputRoot);
    ({ fixtures, arms } = loadFixturesAndArms(assembled.loaded, assembled.suite));
  } catch (error) {
    printCaughtError(error, context, 'resume failed');
    return EXIT_CONFIG;
  }

  try {
    const result = await runExperiment({
      experimentRoot: outputRoot,
      suite: assembled.suite,
      suiteRoot: assembled.loaded.manifestDir,
      suiteFingerprint: assembled.suiteFingerprint,
      trialPlan,
      preregistration,
      fixtures,
      arms,
      adapter: assembled.adapter,
      isolation: resolveIsolationForSuite(assembled.suite, assembled.adapter, outputRoot),
      sourceRepositoryPath: join(assembled.loaded.manifestDir, assembled.suite.repository.path),
      agentFingerprint: computeFingerprint(assembled.suite.agent),
      isolationFingerprint: computeFingerprint(assembled.suite.isolation),
      pricingFingerprint: pricingFingerprintForSuite(assembled.loaded.manifestDir),
      concurrency: assembled.suite.defaults.concurrency,
    });
    context.stdout(`completed ${String(result.completedTrials)} trials\n`);
    if (result.cancelled) {
      context.stderr('experiment interrupted; resume to continue\n');
    }
    return EXIT_OK;
  } catch (error) {
    printCaughtError(error, context, 'resume failed');
    return EXIT_RUNTIME;
  }
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
