import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { planCommand, runCommand } from '../../packages/cli/src/commands/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const examplesRoot = join(repoRoot, 'examples/minimal');
const suitePath = join(examplesRoot, 'suite.yaml');
const fakeAgentPath = join(repoRoot, 'tests/fake-agent/fake-agent.mjs');

describe('minimal vertical slice', () => {
  it('runs plan and fake-agent experiment end to end', async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'ael-minimal-'));
    const logs: string[] = [];

    const planCode = planCommand(
      suitePath,
      outputRoot,
      {
        stdout: (message) => logs.push(message),
        stderr: (message) => logs.push(message),
      },
      false,
    );
    expect(planCode).toBe(0);
    expect(existsSync(join(outputRoot, 'trial-plan.json'))).toBe(true);
    expect(existsSync(join(outputRoot, 'preregistration.json'))).toBe(true);

    const runCode = await runCommand(suitePath, outputRoot, fakeAgentPath, {
      stdout: (message) => logs.push(message),
      stderr: (message) => logs.push(message),
    });
    expect(runCode).toBe(0);

    const trialPlan = JSON.parse(readFileSync(join(outputRoot, 'trial-plan.json'), 'utf8')) as {
      counts: { trials: number };
    };
    expect(trialPlan.counts.trials).toBe(6);
    expect(logs.join('')).toContain('completed');
  }, 120_000);
});
