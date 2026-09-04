import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { parseFixtureDocument } from '@ael/core';

import { cloneDetachedRepository } from '../../src/git/clone.js';
import { runFixtureSelfTest } from '../../src/grading/fixtureValidation.js';

const FIXED_DATE = '2026-01-01T00:00:00Z';
const GIT_CONFIG = [
  '-c',
  'user.name=AEL',
  '-c',
  'user.email=ael@example.com',
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.filemode=false',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'init.defaultBranch=main',
];

function runGit(cwd: string, args: string[]): string {
  const env = { ...process.env, GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) {
    delete env[key];
  }
  const result = spawnSync('git', [...GIT_CONFIG, ...args], {
    cwd,
    encoding: 'utf8',
    env,
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, contents, 'utf8');
  }
}

function createTempGitRepo(files: Record<string, string>): { path: string; commit: string } {
  const path = mkdtempSync(join(tmpdir(), 'ael-fixture-seed-'));
  writeTree(path, files);
  runGit(path, ['init', '--quiet']);
  runGit(path, ['add', '--all']);
  runGit(path, ['commit', '--quiet', '--no-verify', '--message', 'seed']);
  return { path, commit: runGit(path, ['rev-parse', 'HEAD']) };
}

async function diffPatch(
  seedPath: string,
  commit: string,
  edits: Record<string, string>,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'ael-fixture-patch-'));
  await cloneDetachedRepository({ sourcePath: seedPath, targetPath: dir, commit });
  writeTree(dir, edits);
  const result = spawnSync('git', ['diff', '--binary', 'HEAD'], {
    cwd: dir,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git diff failed: ${result.stderr}`);
  }
  return result.stdout;
}

const FIXTURE_YAML = `schemaVersion: 1
id: unit-value
name: Unit value
category: bug-fix
outcomeMode: repository

phases:
  - id: initial
    promptFile: ./prompts/initial.md
    session: new

limits:
  timeoutMsPerPhase: 30000
  maxChangedFiles: 5

candidate:
  allowedPaths:
    - src/**
  forbiddenPaths:
    - grader/**

grading:
  deterministic:
    - id: value-check
      command: node
      args: [./grader/check.mjs]
      required: true
  blindedRubric:
    enabled: false
    rubricFile: null
    minimumRaters: 0
    minimumAgreement: null
  llmJudge:
    role: disabled

reference:
  solutionPatch: ./reference/solution.patch
  mutationCases:
    - ./reference/wrong.patch
`;

const CLEAN_GRADER = `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function finish(pass, reason) {
  process.stdout.write(JSON.stringify({ pass, reason }) + '\\n');
  process.exit(pass ? 0 : 1);
}

const value = readFileSync(join(process.cwd(), 'src', 'value.txt'), 'utf8').trim();
if (value !== '1') {
  finish(false, 'expected 1');
}
finish(true, 'ok');
`;

const MUTATING_GRADER = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function finish(pass, reason) {
  process.stdout.write(JSON.stringify({ pass, reason }) + '\\n');
  process.exit(pass ? 0 : 1);
}

const path = join(process.cwd(), 'src', 'value.txt');
const value = readFileSync(path, 'utf8').trim();
writeFileSync(path, value + '\\n# grader-mutated\\n', 'utf8');
if (value !== '1') {
  finish(false, 'expected 1');
}
finish(true, 'ok');
`;

function materializeFixture(graderSource: string, solution: string, wrong: string): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ael-fixture-root-'));
  writeTree(fixtureRoot, {
    'fixture.yaml': FIXTURE_YAML,
    'prompts/initial.md': 'Set src/value.txt to 1.\n',
    'grader/check.mjs': graderSource,
    'reference/solution.patch': solution,
    'reference/wrong.patch': wrong,
  });
  return fixtureRoot;
}

function parseFixture(fixtureRoot: string) {
  const fixturePath = join(fixtureRoot, 'fixture.yaml');
  return parseFixtureDocument(parseYaml(readFileSync(fixturePath, 'utf8')), fixturePath);
}

describe('fixtureValidation', () => {
  it('seed fails, reference passes, mutations fail on a temp git repo', async () => {
    const seed = createTempGitRepo({
      'README.md': 'seed\n',
      'src/value.txt': '0\n',
    });
    const solution = await diffPatch(seed.path, seed.commit, { 'src/value.txt': '1\n' });
    const wrong = await diffPatch(seed.path, seed.commit, { 'src/value.txt': '2\n' });
    const fixtureRoot = materializeFixture(CLEAN_GRADER, solution, wrong);
    const workDir = mkdtempSync(join(tmpdir(), 'ael-fixture-val-'));
    const result = await runFixtureSelfTest({
      fixture: parseFixture(fixtureRoot),
      fixtureRoot,
      seedRepositoryPath: seed.path,
      repositoryCommit: seed.commit,
      workDir,
      repeatCount: 3,
    });
    expect(result.messages.join('; ')).toBe('');
    expect(result.seedFails).toBe(true);
    expect(result.referencePasses).toBe(true);
    expect(result.mutationsFail).toBe(true);
    expect(result.flakeDetected).toBe(false);
    expect(result.graderMutatesCandidate).toBe(false);
    expect(result.valid).toBe(true);
  }, 30_000);

  it('flags a grader that mutates the candidate workspace', async () => {
    const seed = createTempGitRepo({
      'README.md': 'seed\n',
      'src/value.txt': '0\n',
    });
    const solution = await diffPatch(seed.path, seed.commit, { 'src/value.txt': '1\n' });
    const wrong = await diffPatch(seed.path, seed.commit, { 'src/value.txt': '2\n' });
    const fixtureRoot = materializeFixture(MUTATING_GRADER, solution, wrong);
    const workDir = mkdtempSync(join(tmpdir(), 'ael-fixture-mut-'));
    const result = await runFixtureSelfTest({
      fixture: parseFixture(fixtureRoot),
      fixtureRoot,
      seedRepositoryPath: seed.path,
      repositoryCommit: seed.commit,
      workDir,
      repeatCount: 1,
    });
    expect(result.seedFails).toBe(true);
    expect(result.referencePasses).toBe(true);
    expect(result.graderMutatesCandidate).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.messages.some((message) => message.includes('grader mutates'))).toBe(true);
  }, 30_000);

  it('runs concurrent self-tests without colliding workspaces', async () => {
    const seed = createTempGitRepo({
      'README.md': 'seed\n',
      'src/value.txt': '0\n',
    });
    const solution = await diffPatch(seed.path, seed.commit, { 'src/value.txt': '1\n' });
    const wrong = await diffPatch(seed.path, seed.commit, { 'src/value.txt': '2\n' });
    const fixtureRoot = materializeFixture(CLEAN_GRADER, solution, wrong);
    const shared = mkdtempSync(join(tmpdir(), 'ael-fixture-shared-'));
    const fixture = parseFixture(fixtureRoot);
    const results = await Promise.all([
      runFixtureSelfTest({
        fixture,
        fixtureRoot,
        seedRepositoryPath: seed.path,
        repositoryCommit: seed.commit,
        workDir: shared,
        repeatCount: 1,
      }),
      runFixtureSelfTest({
        fixture,
        fixtureRoot,
        seedRepositoryPath: seed.path,
        repositoryCommit: seed.commit,
        workDir: shared,
        repeatCount: 1,
      }),
    ]);
    expect(results.every((result) => result.valid)).toBe(true);
  }, 30_000);
});
