import { mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, beforeAll } from 'vitest';

import { parseFixtureDocument } from '@ael/core';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { runFixtureSelfTest } from '../../packages/runtime/src/grading/fixtureValidation.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const examplesRoot = join(repoRoot, 'examples/minimal');

describe('M2 qualification: fixture self-test matrix', () => {
  beforeAll(() => {
    const init = spawnSync(process.execPath, [join(examplesRoot, 'scripts/init-seed-repo.mjs')], {
      encoding: 'utf8',
    });
    if (init.status !== 0) {
      throw new Error(init.stderr || 'failed to initialize seed repo');
    }
  });

  const fixtures = ['fix-a', 'fix-b', 'fix-c'];
  const arms = ['baseline', 'treatment'];
  const repeats = 3;

  for (const fixtureId of fixtures) {
    for (const armId of arms) {
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        it(`${fixtureId} × ${armId} × repeat ${String(repeat)} passes self-test`, async () => {
          const fixturePath = join(examplesRoot, 'fixtures', fixtureId, 'fixture.yaml');
          const fixture = parseFixtureDocument(
            parseYaml(readFileSync(fixturePath, 'utf8')),
            fixturePath,
          );
          const workDir = mkdtempSync(
            join(tmpdir(), `ael-qual-${fixtureId}-${armId}-${String(repeat)}-`),
          );
          const result = await runFixtureSelfTest({
            fixture,
            fixtureRoot: join(examplesRoot, 'fixtures', fixtureId),
            seedRepositoryPath: join(examplesRoot, 'seed-repo'),
            repositoryCommit: '8fc35dac5eef18ad0e4d61a8e3ad6c6ba814511c',
            workDir,
            repeatCount: 1,
          });
          void armId;
          expect(result.valid).toBe(true);
        }, 30_000);
      }
    }
  }
});
