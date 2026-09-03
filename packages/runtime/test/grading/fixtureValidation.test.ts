import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { parseFixtureDocument } from '@ael/core';
import { readFileSync } from 'node:fs';

import { runFixtureSelfTest } from '../../src/grading/fixtureValidation.js';

const examplesRoot = join(import.meta.dirname, '../../../../examples/minimal');

describe('fixtureValidation', () => {
  it('seed fails, reference passes, mutations fail', async () => {
    const fixturePath = join(examplesRoot, 'fixtures/fix-a/fixture.yaml');
    const fixture = parseFixtureDocument(parseYaml(readFileSync(fixturePath, 'utf8')), fixturePath);
    const workDir = mkdtempSync(join(tmpdir(), 'ael-fixture-val-'));
    const result = await runFixtureSelfTest({
      fixture,
      fixtureRoot: join(examplesRoot, 'fixtures/fix-a'),
      seedRepositoryPath: join(examplesRoot, 'seed-repo'),
      repositoryCommit: '8fc35dac5eef18ad0e4d61a8e3ad6c6ba814511c',
      workDir,
      repeatCount: 3,
    });
    expect(result.seedFails).toBe(true);
    expect(result.referencePasses).toBe(true);
    expect(result.mutationsFail).toBe(true);
    expect(result.flakeDetected).toBe(false);
    expect(result.graderMutatesCandidate).toBe(false);
    expect(result.valid).toBe(true);
  });
});
