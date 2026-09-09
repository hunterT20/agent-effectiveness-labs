import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readCursorAgentVersion } from '@ael/runtime';

import { doctorCommand, planCommand } from '../../packages/cli/src/commands/index.js';
import { EXIT_CAPABILITY, EXIT_OK } from '../../packages/cli/src/exitCodes.js';

const examplesRoot = join(dirname(fileURLToPath(import.meta.url)), '../../examples/minimal');
const suiteCursorPath = join(examplesRoot, 'suite-cursor.yaml');

describe('holdpoint B prep (no live cursor-agent)', () => {
  it('doctor works for cursor suite without live runs', async () => {
    const previousSkip = process.env.AEL_SKIP_SANDBOX_PROBE;
    const previousLive = process.env.AEL_LIVE_CURSOR;
    process.env.AEL_SKIP_SANDBOX_PROBE = '1';
    delete process.env.AEL_LIVE_CURSOR;
    const logs: string[] = [];
    try {
      const code = await doctorCommand(suiteCursorPath, {
        stdout: (message) => logs.push(message),
        stderr: (message) => logs.push(message),
      });
      const version = await readCursorAgentVersion();
      expect(code).toBe(version === null ? EXIT_CAPABILITY : EXIT_OK);
      expect(logs.join('')).toContain('cursor');
      expect(logs.join('')).toContain('Holdpoint B');
    } finally {
      if (previousSkip === undefined) {
        delete process.env.AEL_SKIP_SANDBOX_PROBE;
      } else {
        process.env.AEL_SKIP_SANDBOX_PROBE = previousSkip;
      }
      if (previousLive === undefined) {
        delete process.env.AEL_LIVE_CURSOR;
      } else {
        process.env.AEL_LIVE_CURSOR = previousLive;
      }
    }
  }, 30_000);

  it('plan --json reports advisory exposure and fairness warnings', () => {
    const previousSkip = process.env.AEL_SKIP_SANDBOX_PROBE;
    process.env.AEL_SKIP_SANDBOX_PROBE = '1';
    const outputRoot = mkdtempSync(join(tmpdir(), 'ael-plan-cursor-'));
    const logs: string[] = [];
    try {
      const code = planCommand(
        suiteCursorPath,
        outputRoot,
        {
          stdout: (message) => logs.push(message),
          stderr: (message) => logs.push(message),
        },
        true,
      );
      expect(code).toBe(EXIT_OK);
      const payload: unknown = JSON.parse(logs.join(''));
      if (typeof payload !== 'object' || payload === null) {
        throw new Error('plan json was not an object');
      }
      if (
        !('holdpointB' in payload) ||
        !('advisoryCostUsd' in payload) ||
        !('fairnessWarnings' in payload)
      ) {
        throw new Error('plan json missing expected keys');
      }
      const holdpointB = payload.holdpointB;
      const advisoryCostUsd = payload.advisoryCostUsd;
      const fairnessWarnings = payload.fairnessWarnings;
      if (
        typeof holdpointB !== 'object' ||
        holdpointB === null ||
        !('liveRunAuthorized' in holdpointB)
      ) {
        throw new Error('holdpointB missing liveRunAuthorized');
      }
      if (
        typeof advisoryCostUsd !== 'object' ||
        advisoryCostUsd === null ||
        !('quality' in advisoryCostUsd)
      ) {
        throw new Error('advisoryCostUsd missing quality');
      }
      if (!Array.isArray(fairnessWarnings)) {
        throw new Error('fairnessWarnings is not an array');
      }
      expect(holdpointB.liveRunAuthorized).toBe(false);
      expect(advisoryCostUsd.quality).toBe('estimated');
      expect(fairnessWarnings.join(' ')).toContain('Holdpoint B');
    } finally {
      if (previousSkip === undefined) {
        delete process.env.AEL_SKIP_SANDBOX_PROBE;
      } else {
        process.env.AEL_SKIP_SANDBOX_PROBE = previousSkip;
      }
    }
  });
});
