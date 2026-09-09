#!/usr/bin/env node
/**
 * Offline release verification gate (roadmap M4.5 / M4.6).
 *
 * What it proves, end to end, without touching the repository working tree:
 *   1. Required docs, schemas and example suites exist.
 *   2. `pnpm pack` produces installable tarballs for the four public packages.
 *   3. A fresh, empty npm project can install those tarballs (`npm init -y && npm install *.tgz`).
 *   4. The installed `ael` binary works OFFLINE and WITHOUT a live agent:
 *        ael --version | suite validate | plan --json | run (fake agent) | report
 *      Network is blocked twice over: `npm_config_registry` points at an unreachable URL and
 *      every Node process (CLI, fake agent, hidden grader) is started with a preload that makes
 *      `net`/`tls`/`http(s)`/`dns`/`fetch` throw.
 *
 * Everything is written under `mkdtemp(os.tmpdir())`; nothing is created inside the repo.
 *
 * Prerequisites: `pnpm build` (dist/ must exist). The tarball install step (3) is the only step
 * that may talk to a registry, because third-party dependencies (commander, zod, yaml, ...) have
 * to come from somewhere; steps 4+ are enforced offline.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const keepTmp = process.argv.includes('--keep');
const UNREACHABLE_REGISTRY = 'http://127.0.0.1:9/';

const requiredDocs = [
  'README.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'docs/architecture.md',
  'docs/threat-model.md',
  'docs/experiment-methodology.md',
  'docs/fixture-authoring.md',
  'docs/arm-authoring.md',
  'docs/adapter-authoring.md',
  'docs/grading.md',
  'docs/telemetry.md',
  'docs/report-contract.md',
  'docs/cli.md',
  'docs/releasing.md',
];

const requiredExamples = ['examples/minimal/suite.yaml', 'examples/awh-vs-baseline/suite.yaml'];

const requiredSchemas = ['suite', 'fixture', 'arm', 'pricing', 'gradeReport', 'gateResult'];

// Publish order matters for humans reading the log; npm resolves them as one graph anyway.
const publicPackages = ['core', 'reporter', 'runtime', 'cli'];

const suitePath = join(repoRoot, 'examples/minimal/suite.yaml');
const fakeAgentPath = join(repoRoot, 'tests/fake-agent/fake-agent.mjs');

function log(message) {
  process.stderr.write(`verify-release: ${message}\n`);
}

function fail(message) {
  process.stderr.write(`verify-release: FAIL ${message}\n`);
  process.exit(1);
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    return { status: 1, stdout: '', stderr: String(result.error.message) };
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function describeFailure(result) {
  return `${result.stderr.trim()}\n${result.stdout.trim()}`.trim();
}

// ---------------------------------------------------------------------------------------------
// 1. Static checks
// ---------------------------------------------------------------------------------------------
for (const relativePath of [...requiredDocs, ...requiredExamples]) {
  if (!existsSync(join(repoRoot, relativePath))) {
    fail(`missing required file ${relativePath}`);
  }
}
for (const schema of requiredSchemas) {
  if (!existsSync(join(repoRoot, 'schemas', `${schema}.schema.json`))) {
    fail(`missing schema ${schema}.schema.json`);
  }
}
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
for (const marker of ['skill-eval-harness', 'Boundary of universal support', 'INSUFFICIENT_DATA']) {
  if (!readme.includes(marker)) {
    fail(`README missing "${marker}" section`);
  }
}
for (const pkg of publicPackages) {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, 'packages', pkg, 'package.json'), 'utf8'),
  );
  if (manifest.license !== 'MIT') fail(`packages/${pkg}: license must be MIT`);
  if (!existsSync(join(repoRoot, 'packages', pkg, 'LICENSE')))
    fail(`packages/${pkg}: LICENSE missing`);
  if (manifest.publishConfig?.provenance !== true)
    fail(`packages/${pkg}: publishConfig.provenance`);
  if (!existsSync(join(repoRoot, 'packages', pkg, 'dist', 'index.js'))) {
    fail(`packages/${pkg}/dist missing; run pnpm build first`);
  }
}
const cliVersion = JSON.parse(
  readFileSync(join(repoRoot, 'packages/cli/package.json'), 'utf8'),
).version;
log('static checks ok');

// ---------------------------------------------------------------------------------------------
// 2. Seed repository for examples/minimal (idempotent, verifies pinned commit)
// ---------------------------------------------------------------------------------------------
const seed = run(
  process.execPath,
  [join(repoRoot, 'examples/minimal/scripts/init-seed-repo.mjs')],
  {
    cwd: repoRoot,
  },
);
if (seed.status !== 0) {
  fail(`seed repo init failed: ${describeFailure(seed)}`);
}
log(`seed repo at ${seed.stdout.trim()}`);

// ---------------------------------------------------------------------------------------------
// 3. Temp workspace: pack tarballs + install into a fresh project
// ---------------------------------------------------------------------------------------------
const tmpRoot = mkdtempSync(join(tmpdir(), 'ael-verify-release-'));
const tarballDir = join(tmpRoot, 'tarballs');
const projectDir = join(tmpRoot, 'project');
const outputRoot = join(tmpRoot, 'experiment');
const planRoot = join(tmpRoot, 'plan');
mkdirSync(tarballDir);
mkdirSync(projectDir);
log(`temp root ${tmpRoot}`);

const cleanup = () => {
  if (!keepTmp) {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
};
process.on('exit', cleanup);

const offlineEnv = {
  ...process.env,
  npm_config_registry: UNREACHABLE_REGISTRY,
  NPM_CONFIG_REGISTRY: UNREACHABLE_REGISTRY,
};

for (const pkg of publicPackages) {
  const pack = run('pnpm', ['pack', '--pack-destination', tarballDir], {
    cwd: join(repoRoot, 'packages', pkg),
    env: offlineEnv,
  });
  if (pack.status !== 0) {
    fail(`pnpm pack @ael/${pkg} failed: ${describeFailure(pack)}`);
  }
}
const tarballs = readdirSync(tarballDir)
  .filter((name) => name.endsWith('.tgz'))
  .map((name) => join(tarballDir, name));
if (tarballs.length !== publicPackages.length) {
  fail(`expected ${String(publicPackages.length)} tarballs, found ${String(tarballs.length)}`);
}
log(`packed ${String(tarballs.length)} tarballs`);

const init = run('npm', ['init', '-y'], { cwd: projectDir, env: offlineEnv });
if (init.status !== 0) {
  fail(`npm init failed: ${describeFailure(init)}`);
}
// The only step allowed to reach a registry (third-party deps). Respect a caller-provided
// registry/mirror; otherwise npm's default applies.
const installEnv = { ...process.env };
delete installEnv.NODE_OPTIONS;
const install = run(
  'npm',
  ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', ...tarballs],
  { cwd: projectDir, env: installEnv },
);
if (install.status !== 0) {
  fail(`npm install of packed tarballs failed: ${describeFailure(install)}`);
}
const installedCliRaw = join(projectDir, 'node_modules', '@ael', 'cli', 'dist', 'index.js');
if (!existsSync(installedCliRaw)) {
  fail('installed @ael/cli has no dist/index.js');
}
// macOS: /var is a symlink to /private/var. @ael/cli only runs when
// import.meta.url === pathToFileURL(process.argv[1]).href, so argv must be the realpath.
const installedCli = realpathSync(installedCliRaw);
for (const pkg of publicPackages) {
  const installedLicense = join(projectDir, 'node_modules', '@ael', pkg, 'LICENSE');
  if (!existsSync(installedLicense)) fail(`installed @ael/${pkg} is missing LICENSE`);
}
log('fresh npm project installed all tarballs');

// ---------------------------------------------------------------------------------------------
// 4. Offline enforcement: preload that kills every network primitive, inherited by children.
// ---------------------------------------------------------------------------------------------
const preloadPath = join(tmpRoot, 'deny-network.cjs');
writeFileSync(
  preloadPath,
  `'use strict';
const deny = (name) => function aelDenyNetwork() {
  const error = new Error('verify-release: network access blocked (' + name + ')');
  error.code = 'AEL_OFFLINE';
  throw error;
};
const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
net.connect = deny('net.connect');
net.createConnection = deny('net.createConnection');
net.Socket.prototype.connect = deny('net.Socket#connect');
tls.connect = deny('tls.connect');
http.request = deny('http.request');
http.get = deny('http.get');
https.request = deny('https.request');
https.get = deny('https.get');
dns.lookup = deny('dns.lookup');
dns.resolve = deny('dns.resolve');
dns.promises.lookup = deny('dns.promises.lookup');
dns.promises.resolve = deny('dns.promises.resolve');
globalThis.fetch = deny('fetch');
`,
  'utf8',
);

const cliEnv = {
  ...offlineEnv,
  NODE_OPTIONS: `--require=${preloadPath}`,
  AEL_SKIP_SANDBOX_PROBE: '1',
};

// Self-check: the preload must actually block.
const probe = run(
  process.execPath,
  ['--require', preloadPath, '-e', "require('node:http').get('http://127.0.0.1:9/');"],
  { cwd: tmpRoot, env: cliEnv },
);
if (
  probe.status === 0 ||
  (!probe.stderr.includes('AEL_OFFLINE') && !probe.stderr.includes('network access blocked'))
) {
  fail(`offline preload self-check did not block http.get: ${describeFailure(probe)}`);
}
log('offline preload self-check ok');

function ael(args, options = {}) {
  return run(process.execPath, ['--require', preloadPath, installedCli, ...args], {
    cwd: projectDir,
    env: cliEnv,
    ...options,
  });
}

// ---------------------------------------------------------------------------------------------
// 5. CLI smoke: --version | suite validate | plan --json | run (fake agent) | report
// ---------------------------------------------------------------------------------------------
const version = ael(['--version']);
if (version.status !== 0 || version.stdout.trim() !== cliVersion) {
  fail(
    `ael --version returned "${version.stdout.trim()}" status=${String(version.status)} (expected ${cliVersion}): ${describeFailure(version)}`,
  );
}
log(`ael --version = ${cliVersion}`);

const validate = ael(['suite', 'validate', suitePath]);
if (validate.status !== 0 || !validate.stdout.includes('suite valid')) {
  fail(`ael suite validate failed: ${describeFailure(validate)}`);
}
log('ael suite validate ok');

const plan = ael(['plan', '--suite', suitePath, '--output', planRoot, '--json']);
if (plan.status !== 0) {
  fail(`ael plan failed: ${describeFailure(plan)}`);
}
let planReport;
try {
  planReport = JSON.parse(plan.stdout);
} catch {
  fail('ael plan --json did not emit JSON on stdout');
}
const plannedTrials = planReport?.counts?.trials;
if (typeof plannedTrials !== 'number' || plannedTrials < 1) {
  fail('ael plan --json missing counts.trials');
}
if (
  !existsSync(join(planRoot, 'trial-plan.json')) ||
  !existsSync(join(planRoot, 'preregistration.json'))
) {
  fail('ael plan did not write trial-plan.json / preregistration.json');
}
log(`ael plan ok (${String(plannedTrials)} trials)`);

const runResult = ael([
  'run',
  '--suite',
  suitePath,
  '--output',
  outputRoot,
  '--fake-agent',
  fakeAgentPath,
]);
if (runResult.status !== 0) {
  fail(`ael run (fake agent, offline) failed: ${describeFailure(runResult)}`);
}
const completedMatch = /completed (\d+) trials/.exec(runResult.stdout);
if (completedMatch === null) {
  fail(`ael run did not report completed trials: ${describeFailure(runResult)}`);
}
const completedTrials = Number(completedMatch[1]);
if (completedTrials !== plannedTrials) {
  fail(`ael run completed ${String(completedTrials)} of ${String(plannedTrials)} planned trials`);
}
if (!existsSync(join(outputRoot, 'events.ndjson'))) {
  fail('ael run did not write events.ndjson');
}
log(`ael run ok (${String(completedTrials)} trials completed with fake agent)`);

const report = ael(['report', outputRoot, '--suite', suitePath]);
if (report.status !== 0) {
  fail(`ael report failed: ${describeFailure(report)}`);
}
const reportJsonPath = join(outputRoot, 'report', 'report.json');
if (!existsSync(reportJsonPath)) {
  fail('ael report did not write report/report.json');
}
const reportJson = JSON.parse(readFileSync(reportJsonPath, 'utf8'));
if (!['PASSED', 'FAILED', 'INSUFFICIENT_DATA'].includes(reportJson.verdict)) {
  fail(`report.json has unexpected verdict ${String(reportJson.verdict)}`);
}
for (const view of ['report.md', 'report.csv', 'report.html']) {
  if (!existsSync(join(outputRoot, 'report', view))) fail(`ael report did not write ${view}`);
}
log(`ael report ok (verdict ${String(reportJson.verdict)})`);

if (keepTmp) {
  log(`kept temp root ${tmpRoot}`);
}
process.stdout.write('verify-release: ok\n');
