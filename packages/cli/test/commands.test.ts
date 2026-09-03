import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { planCommand, validateSuiteCommand } from '../src/commands/index.js';

const examplesRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../examples/minimal');
const suitePath = join(examplesRoot, 'suite.yaml');

describe('cli commands', () => {
  it('validates the minimal suite', () => {
    const logs: string[] = [];
    const code = validateSuiteCommand(suitePath, {
      stdout: (message) => logs.push(message),
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(logs.join('')).toContain('suite valid');
  });

  it('plans without invoking an agent', () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'ael-plan-'));
    const logs: string[] = [];
    const code = planCommand(
      suitePath,
      outputRoot,
      {
        stdout: (message) => logs.push(message),
        stderr: (message) => logs.push(message),
      },
      true,
    );
    expect(code).toBe(0);
    expect(logs.join('')).toContain('trials');
  });
});
