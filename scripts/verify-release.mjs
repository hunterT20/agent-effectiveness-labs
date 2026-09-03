#!/usr/bin/env node
/**
 * Offline release verification gate.
 * - No network access
 * - No live agent invocation
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const requiredDocs = [
  'README.md',
  'SECURITY.md',
  'docs/architecture.md',
  'docs/threat-model.md',
  'docs/experiment-methodology.md',
  'docs/fixture-authoring.md',
  'docs/arm-authoring.md',
  'docs/adapter-authoring.md',
  'docs/grading.md',
  'docs/telemetry.md',
  'docs/report-contract.md',
];

const requiredExamples = [
  'examples/minimal/suite.yaml',
  'examples/awh-vs-baseline/suite.yaml',
];

function fail(message) {
  console.error(`verify-release: ${message}`);
  process.exit(1);
}

for (const relativePath of [...requiredDocs, ...requiredExamples]) {
  if (!existsSync(join(repoRoot, relativePath))) {
    fail(`missing required file ${relativePath}`);
  }
}

const schemasDir = join(repoRoot, 'schemas');
for (const schema of ['suite', 'fixture', 'arm']) {
  if (!existsSync(join(schemasDir, `${schema}.schema.json`))) {
    fail(`missing schema ${schema}.schema.json`);
  }
}

const pack = spawnSync('pnpm', ['pack', '--pack-destination', '/tmp'], {
  cwd: join(repoRoot, 'packages/cli'),
  encoding: 'utf8',
  env: { ...process.env, npm_config_registry: 'https://invalid.local/' },
});
if (pack.status !== 0) {
  fail(`pack smoke failed: ${pack.stderr || pack.stdout}`);
}

const version = spawnSync('node', ['packages/cli/dist/index.js', '--version'], {
  cwd: repoRoot,
  encoding: 'utf8',
});
if (version.status !== 0) {
  fail('ael --version failed; run pnpm build first');
}

const plan = spawnSync(
  'node',
  [
    'packages/cli/dist/index.js',
    'plan',
    '--suite',
    'examples/minimal/suite.yaml',
    '--output',
    join(repoRoot, '.ael-verify-release-plan'),
    '--json',
  ],
  { cwd: repoRoot, encoding: 'utf8' },
);
if (plan.status !== 0) {
  fail(`offline plan failed: ${plan.stderr || plan.stdout}`);
}

const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
if (!readme.includes('skill-eval-harness')) {
  fail('README missing positioning section');
}

console.log('verify-release: ok');
