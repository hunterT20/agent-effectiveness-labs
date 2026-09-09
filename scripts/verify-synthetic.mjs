#!/usr/bin/env node
/**
 * Synthetic performance smoke (roadmap M4.7): 30 fake-agent trials must finish in < 5 minutes.
 *
 * Uses `examples/minimal/suite-perf.yaml` (3 fixtures x 2 arms x repeats 5 = 30 trials). If that
 * file is missing (older checkout) it falls back to `suite.yaml` with a warning, in which case the
 * trial-count assertion is relaxed to "whatever the plan says".
 *
 * Prerequisites: `pnpm build`. The seed repository is initialized by this script.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const examplesRoot = join(repoRoot, 'examples/minimal');
const perfSuitePath = join(examplesRoot, 'suite-perf.yaml');
const fallbackSuitePath = join(examplesRoot, 'suite.yaml');
const cliPath = join(repoRoot, 'packages/cli/dist/index.js');
const fakeAgentPath = join(repoRoot, 'tests/fake-agent/fake-agent.mjs');

const EXPECTED_TRIALS = 30;
const THRESHOLD_MS = 5 * 60 * 1000;

function fail(message) {
  process.stderr.write(`verify-synthetic: FAIL ${message}\n`);
  process.exit(1);
}

function log(message) {
  process.stderr.write(`verify-synthetic: ${message}\n`);
}

if (!existsSync(cliPath)) {
  fail('packages/cli/dist/index.js missing; run pnpm build first');
}

let suitePath = perfSuitePath;
let expectedTrials = EXPECTED_TRIALS;
if (!existsSync(perfSuitePath)) {
  log(`WARNING ${perfSuitePath} not found; falling back to suite.yaml (trial count not asserted)`);
  suitePath = fallbackSuitePath;
  expectedTrials = null;
}

const seed = spawnSync(process.execPath, [join(examplesRoot, 'scripts/init-seed-repo.mjs')], {
  cwd: repoRoot,
  encoding: 'utf8',
  shell: false,
});
if (seed.status !== 0) {
  fail(`seed repo init failed: ${seed.stderr || seed.stdout}`);
}

const outputRoot = mkdtempSync(join(tmpdir(), 'ael-synthetic-perf-'));
process.on('exit', () => {
  rmSync(outputRoot, { recursive: true, force: true });
});

const started = performance.now();
const run = spawnSync(
  process.execPath,
  [cliPath, 'run', '--suite', suitePath, '--output', outputRoot, '--fake-agent', fakeAgentPath],
  {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, AEL_SKIP_SANDBOX_PROBE: '1' },
  },
);
const elapsedMs = Math.round(performance.now() - started);

if (run.status !== 0) {
  fail(`ael run exited ${String(run.status)}: ${run.stderr || run.stdout}`);
}

const trialPlanPath = join(outputRoot, 'trial-plan.json');
if (!existsSync(trialPlanPath)) {
  fail('trial-plan.json was not written');
}
const trialPlan = JSON.parse(readFileSync(trialPlanPath, 'utf8'));
const plannedTrials = trialPlan?.counts?.trials;
if (typeof plannedTrials !== 'number') {
  fail('trial-plan.json missing counts.trials');
}
if (expectedTrials !== null && plannedTrials !== expectedTrials) {
  fail(`expected ${String(expectedTrials)} planned trials, got ${String(plannedTrials)}`);
}

const completedMatch = /completed (\d+) trials/.exec(run.stdout);
const completedTrials = completedMatch === null ? null : Number(completedMatch[1]);
if (completedTrials !== plannedTrials) {
  fail(`completed ${String(completedTrials)} of ${String(plannedTrials)} planned trials`);
}

if (elapsedMs > THRESHOLD_MS) {
  fail(`synthetic perf smoke exceeded 5 minutes: ${String(elapsedMs)}ms for ${String(plannedTrials)} trials`);
}

process.stdout.write(
  `verify-synthetic: ok ${String(plannedTrials)} trials in ${String(elapsedMs)}ms (${suitePath === perfSuitePath ? 'suite-perf.yaml' : 'suite.yaml fallback'})\n`,
);
