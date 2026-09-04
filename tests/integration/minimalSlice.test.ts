import { existsSync, globSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, beforeAll } from 'vitest';

import { planCommand, reportCommand, runCommand } from '../../packages/cli/src/commands/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const examplesRoot = join(repoRoot, 'examples/minimal');
const suitePath = join(examplesRoot, 'suite.yaml');

function writeOracleAgent(targetPath, fixturesRoot) {
  writeFileSync(
    targetPath,
    `#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const fixturesRoot = ${JSON.stringify(fixturesRoot)};

function parseArgs(argv) {
  const options = { workspace: process.cwd(), prompt: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--workspace') {
      options.workspace = argv[index + 1] ?? options.workspace;
      index += 1;
    } else if (token === '--prompt') {
      options.prompt = argv[index + 1] ?? null;
      index += 1;
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.prompt === null) {
  process.exit(0);
}
const prompt = readFileSync(options.prompt, 'utf8');
for (const id of readdirSync(fixturesRoot)) {
  const fixtureDir = join(fixturesRoot, id);
  for (const name of ['initial.md', 'recovery.md']) {
    const promptPath = join(fixtureDir, 'prompts', name);
    if (!existsSync(promptPath) || readFileSync(promptPath, 'utf8') !== prompt) {
      continue;
    }
    const patch = join(fixtureDir, 'reference', 'solution.patch');
    const artifacts = join(fixtureDir, 'reference', 'artifacts');
    if (existsSync(patch)) {
      const check = spawnSync('git', ['apply', '--binary', '--check', patch], {
        cwd: options.workspace,
        encoding: 'utf8',
        shell: false,
      });
      if (check.status === 0) {
        spawnSync('git', ['apply', '--binary', patch], {
          cwd: options.workspace,
          encoding: 'utf8',
          shell: false,
        });
      }
    }
    if (existsSync(artifacts)) {
      cpSync(artifacts, options.workspace, { recursive: true });
    }
    process.exit(0);
  }
}
process.exit(0);
`,
    'utf8',
  );
}

describe('minimal vertical slice', () => {
  beforeAll(() => {
    const init = spawnSync(process.execPath, [join(examplesRoot, 'scripts/init-seed-repo.mjs')], {
      encoding: 'utf8',
    });
    if (init.status !== 0) {
      throw new Error(init.stderr || 'failed to initialize seed repo');
    }
    const commit = init.stdout.trim();
    const suiteRaw = readFileSync(suitePath, 'utf8');
    if (!suiteRaw.includes(commit)) {
      throw new Error(`suite.yaml commit ${commit} mismatch; update repository.commit`);
    }
  });

  it('runs plan, oracle experiment, and report with a verified_success grade', async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'ael-minimal-'));
    const logs = [];
    const io = {
      stdout: (message) => logs.push(message),
      stderr: (message) => logs.push(message),
    };

    const planCode = planCommand(suitePath, outputRoot, io, false);
    expect(planCode).toBe(0);
    expect(existsSync(join(outputRoot, 'trial-plan.json'))).toBe(true);
    expect(existsSync(join(outputRoot, 'preregistration.json'))).toBe(true);

    const oraclePath = join(outputRoot, 'oracle-agent.mjs');
    writeOracleAgent(oraclePath, join(examplesRoot, 'fixtures'));

    const runCode = await runCommand(suitePath, outputRoot, oraclePath, io);
    expect(runCode).toBe(0);

    const trialPlan = JSON.parse(readFileSync(join(outputRoot, 'trial-plan.json'), 'utf8')) as {
      counts: { trials: number };
    };
    expect(trialPlan.counts.trials).toBe(18);
    expect(logs.join('')).toContain('completed');

    const gradeFiles = globSync('attempts/*/*/grade.json', { cwd: outputRoot });
    expect(gradeFiles.length).toBeGreaterThan(0);
    const statuses = gradeFiles.map((relativePath) => {
      const grade = JSON.parse(readFileSync(join(outputRoot, relativePath), 'utf8')) as {
        status: string;
      };
      return grade.status;
    });
    expect(statuses).toContain('verified_success');

    const reportCode = reportCommand(outputRoot, suitePath, io);
    expect(reportCode).toBe(0);
    expect(existsSync(join(outputRoot, 'report', 'report.json'))).toBe(true);
  }, 180_000);
});
