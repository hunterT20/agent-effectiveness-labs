import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { doctorCommand, planCommand } from '../../packages/cli/src/commands/index.js';

const examplesRoot = join(dirname(fileURLToPath(import.meta.url)), '../../examples/minimal');
const suiteCursorPath = join(examplesRoot, 'suite-cursor.yaml');

describe('holdpoint B prep (no live cursor-agent)', () => {
  it('doctor works for cursor suite without live runs', async () => {
    process.env.AEL_SKIP_SANDBOX_PROBE = '1';
    const logs: string[] = [];
    const code = await doctorCommand(suiteCursorPath, {
      stdout: (message) => logs.push(message),
      stderr: (message) => logs.push(message),
    });
    expect(code).toBe(0);
    expect(logs.join('')).toContain('cursor');
    expect(logs.join('')).toContain('Holdpoint B');
    delete process.env.AEL_SKIP_SANDBOX_PROBE;
  }, 30_000);

  it('plan --json reports advisory exposure and fairness warnings', () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'ael-plan-cursor-'));
    const logs: string[] = [];
    const code = planCommand(
      suiteCursorPath,
      outputRoot,
      {
        stdout: (message) => logs.push(message),
        stderr: (message) => logs.push(message),
      },
      true,
    );
    expect(code).toBe(0);
    const payload = JSON.parse(logs.join('')) as {
      holdpointB: { liveRunAuthorized: boolean };
      advisoryCostUsd: { quality: string };
      fairnessWarnings: string[];
    };
    expect(payload.holdpointB.liveRunAuthorized).toBe(false);
    expect(payload.advisoryCostUsd.quality).toBe('estimated');
    expect(payload.fairnessWarnings.join(' ')).toContain('Holdpoint B');
  });
});
