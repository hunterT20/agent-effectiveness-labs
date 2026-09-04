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

describe('examples/minimal fixture self-test (repeatCount 3)', () => {
  let repositoryCommit = '';

  beforeAll(() => {
    const init = spawnSync(process.execPath, [join(examplesRoot, 'scripts/init-seed-repo.mjs')], {
      encoding: 'utf8',
    });
    if (init.status !== 0) {
      throw new Error(init.stderr || 'failed to initialize seed repo');
    }
    repositoryCommit = init.stdout.trim();
  });

  const fixtures = ['fix-a', 'fix-b', 'fix-c'];

  for (const fixtureId of fixtures) {
    it(`${fixtureId} passes self-test with repeatCount 3`, async () => {
      const fixturePath = join(examplesRoot, 'fixtures', fixtureId, 'fixture.yaml');
      const fixture = parseFixtureDocument(parseYaml(readFileSync(fixturePath, 'utf8')), fixturePath);
      const workDir = mkdtempSync(join(tmpdir(), `ael-qual-${fixtureId}-`));
      const result = await runFixtureSelfTest({
        fixture,
        fixtureRoot: join(examplesRoot, 'fixtures', fixtureId),
        seedRepositoryPath: join(examplesRoot, 'seed-repo'),
        repositoryCommit,
        workDir,
        repeatCount: 3,
      });
      expect(result.valid, result.messages.join('; ')).toBe(true);
    }, 60_000);
  }

  it.todo('timeout fault-injection');
  it.todo('crash fault-injection');
  it.todo('malformed-telemetry fault-injection');
  it.todo('grader-failure fault-injection');
  it.todo('resume fault-injection');
});
