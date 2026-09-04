import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { FixtureDocument } from '@ael/core';

import { cloneDetachedRepository, gitDiffBinary } from '../../src/git/clone.js';
import { parseGraderResultLine, runHiddenGrader } from '../../src/grading/hiddenGrader.js';
import { createTempSeedRepo } from '../helpers/tempSeedRepo.js';

function fixtureWithGrader(command: string, args: string[]): FixtureDocument {
  return {
    schemaVersion: 1,
    id: 'g',
    name: 'g',
    category: 'basic',
    outcomeMode: 'repository',
    phases: [{ id: 'initial', promptFile: './prompts/initial.md', session: 'new' }],
    limits: { timeoutMsPerPhase: 2000, maxChangedFiles: 5 },
    candidate: { allowedPaths: ['src/**'], forbiddenPaths: ['grader/**'] },
    grading: {
      deterministic: [{ id: 'answer-check', command, args, required: true }],
      blindedRubric: {
        enabled: false,
        rubricFile: null,
        minimumRaters: 0,
        minimumAgreement: null,
      },
      llmJudge: { role: 'disabled' },
    },
    reference: {},
  };
}

describe('parseGraderResultLine', () => {
  it('accepts {pass:false} JSON and the AEL_GRADER_RESULT prefix', () => {
    expect(parseGraderResultLine('{"pass":false,"message":"nope"}\n')).toEqual({
      pass: false,
      message: 'nope',
    });
    expect(parseGraderResultLine('AEL_GRADER_RESULT: {"passed":true}\n')).toEqual({
      passed: true,
    });
  });
});

describe('runHiddenGrader', () => {
  it('maps exit 0 to verified_success and exit 1 + {pass:false} to incorrect', async () => {
    const seed = await createTempSeedRepo();
    const workspace = mkdtempSync(join(tmpdir(), 'ael-grade-ws-'));
    await cloneDetachedRepository({
      sourcePath: seed.repoPath,
      targetPath: workspace,
      commit: seed.commit,
    });
    writeFileSync(join(workspace, 'src', 'answer.txt'), 'correct-answer\n', 'utf8');
    const patch = await gitDiffBinary(workspace);
    const artifactDir = mkdtempSync(join(tmpdir(), 'ael-grade-art-'));
    const patchPath = join(artifactDir, 'candidate.patch');
    writeFileSync(patchPath, patch, 'utf8');

    const fixtureRoot = mkdtempSync(join(tmpdir(), 'ael-grade-fx-'));
    mkdirSync(join(fixtureRoot, 'grader'), { recursive: true });
    writeFileSync(
      join(fixtureRoot, 'grader', 'check.mjs'),
      `import { readFileSync } from 'node:fs';
const answer = readFileSync('src/answer.txt','utf8').trim();
if (answer !== 'correct-answer') {
  console.log(JSON.stringify({ pass: false, message: 'incorrect' }));
  process.exit(1);
}
console.log(JSON.stringify({ pass: true, message: 'ok' }));
process.exit(0);
`,
      'utf8',
    );

    const pass = await runHiddenGrader({
      fixture: fixtureWithGrader('node', ['./grader/check.mjs']),
      fixtureRoot,
      gradingWorkspaceRoot: mkdtempSync(join(tmpdir(), 'ael-grade-out-')),
      candidatePatchPath: patchPath,
      overlayIntegrity: 'unchanged',
      seedRepositoryPath: seed.repoPath,
      repositoryCommit: seed.commit,
    });
    expect(pass.status).toBe('verified_success');

    writeFileSync(join(workspace, 'src', 'answer.txt'), 'wrong-answer\n', 'utf8');
    const wrongPatchPath = join(artifactDir, 'wrong.patch');
    writeFileSync(wrongPatchPath, await gitDiffBinary(workspace), 'utf8');
    const fail = await runHiddenGrader({
      fixture: fixtureWithGrader('node', ['./grader/check.mjs']),
      fixtureRoot,
      gradingWorkspaceRoot: mkdtempSync(join(tmpdir(), 'ael-grade-out2-')),
      candidatePatchPath: wrongPatchPath,
      overlayIntegrity: 'unchanged',
      seedRepositoryPath: seed.repoPath,
      repositoryCommit: seed.commit,
    });
    expect(fail.status).toBe('incorrect');
  });

  it('returns invalid_trial for crash, timeout, missing check, and patch failure', async () => {
    const seed = await createTempSeedRepo();
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'ael-inv-fx-'));
    mkdirSync(join(fixtureRoot, 'grader'), { recursive: true });
    writeFileSync(join(fixtureRoot, 'grader', 'check.mjs'), 'process.exit(2);\n', 'utf8');
    const emptyPatch = join(fixtureRoot, 'empty.patch');
    writeFileSync(emptyPatch, '', 'utf8');

    const crashed = await runHiddenGrader({
      fixture: fixtureWithGrader('node', ['./grader/check.mjs']),
      fixtureRoot,
      gradingWorkspaceRoot: mkdtempSync(join(tmpdir(), 'ael-inv-crash-')),
      candidatePatchPath: emptyPatch,
      overlayIntegrity: 'unchanged',
      seedRepositoryPath: seed.repoPath,
      repositoryCommit: seed.commit,
    });
    expect(crashed.status).toBe('invalid_trial');

    const missing = await runHiddenGrader({
      fixture: fixtureWithGrader('node', ['./grader/missing.mjs']),
      fixtureRoot,
      gradingWorkspaceRoot: mkdtempSync(join(tmpdir(), 'ael-inv-miss-')),
      candidatePatchPath: emptyPatch,
      overlayIntegrity: 'unchanged',
      seedRepositoryPath: seed.repoPath,
      repositoryCommit: seed.commit,
    });
    expect(missing.status).toBe('invalid_trial');
    expect(missing.checks.some((check) => check.message.includes('missing check'))).toBe(true);

    const badPatch = join(fixtureRoot, 'bad.patch');
    writeFileSync(badPatch, 'not-a-patch\n', 'utf8');
    const patchFail = await runHiddenGrader({
      fixture: fixtureWithGrader('node', ['./grader/check.mjs']),
      fixtureRoot,
      gradingWorkspaceRoot: mkdtempSync(join(tmpdir(), 'ael-inv-patch-')),
      candidatePatchPath: badPatch,
      overlayIntegrity: 'unchanged',
      seedRepositoryPath: seed.repoPath,
      repositoryCommit: seed.commit,
    });
    expect(patchFail.status).toBe('invalid_trial');

    writeFileSync(
      join(fixtureRoot, 'grader', 'hang.mjs'),
      'setTimeout(() => {}, 60_000);\n',
      'utf8',
    );
    const hang = await runHiddenGrader({
      fixture: {
        ...fixtureWithGrader('node', ['./grader/hang.mjs']),
        limits: { timeoutMsPerPhase: 400, maxChangedFiles: 5 },
      },
      fixtureRoot,
      gradingWorkspaceRoot: mkdtempSync(join(tmpdir(), 'ael-inv-hang-')),
      candidatePatchPath: emptyPatch,
      overlayIntegrity: 'unchanged',
      seedRepositoryPath: seed.repoPath,
      repositoryCommit: seed.commit,
    });
    expect(hang.status).toBe('invalid_trial');
  });

  it('marks overlay tamper as invalid_trial', async () => {
    const seed = await createTempSeedRepo();
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'ael-tamp-fx-'));
    mkdirSync(join(fixtureRoot, 'grader'), { recursive: true });
    writeFileSync(join(fixtureRoot, 'grader', 'check.mjs'), 'process.exit(0);\n', 'utf8');
    const emptyPatch = join(fixtureRoot, 'empty.patch');
    writeFileSync(emptyPatch, '', 'utf8');
    const report = await runHiddenGrader({
      fixture: fixtureWithGrader('node', ['./grader/check.mjs']),
      fixtureRoot,
      gradingWorkspaceRoot: mkdtempSync(join(tmpdir(), 'ael-tamp-out-')),
      candidatePatchPath: emptyPatch,
      overlayIntegrity: 'tampered',
      seedRepositoryPath: seed.repoPath,
      repositoryCommit: seed.commit,
    });
    expect(report.status).toBe('invalid_trial');
    expect(report.testTampering).toBe(true);
  });
});
