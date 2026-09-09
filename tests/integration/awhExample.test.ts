import { mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSuiteManifest, parseFixtureDocument } from '@ael/core';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it, beforeAll } from 'vitest';

import { runFixtureSelfTest } from '../../packages/runtime/src/grading/fixtureValidation.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const examplesRoot = join(repoRoot, 'examples/awh-vs-baseline');
const suitePath = join(examplesRoot, 'suite.yaml');

describe('awh-vs-baseline example suite', () => {
  let repositoryCommit = '';

  beforeAll(() => {
    const init = spawnSync(process.execPath, [join(examplesRoot, 'scripts/init-seed-repo.mjs')], {
      encoding: 'utf8',
    });
    if (init.status !== 0) {
      throw new Error(init.stderr || 'failed to initialize awh seed repo');
    }
    repositoryCommit = init.stdout.trim();
    const loaded = loadSuiteManifest(suitePath);
    expect(loaded.normalizedValue.repository.commit).toBe(repositoryCommit);
    expect(loaded.normalizedValue.fixtures.length).toBeGreaterThanOrEqual(10);
  });

  const fixtureIds = [
    'bug-fix',
    'multi-file',
    'regression-trap',
    'stale-evidence',
    'dangerous-command',
    'safe-action',
    'rollback',
    'two-phase-recovery',
    'scope-control',
    'review',
    'artifact-only',
  ];

  for (const fixtureId of fixtureIds) {
    it(`${fixtureId} passes fixture self-test`, async () => {
      const fixturePath = join(examplesRoot, 'fixtures', fixtureId, 'fixture.yaml');
      const fixture = parseFixtureDocument(parseYaml(readFileSync(fixturePath, 'utf8')), fixturePath);
      const workDir = mkdtempSync(join(tmpdir(), `ael-awh-${fixtureId}-`));
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
});
