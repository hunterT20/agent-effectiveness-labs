import type { FixtureDocument, GradeReport } from '@ael/core';

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { computeTreeFingerprint } from '../git/fingerprint.js';
import { reconstructCandidate } from '../workspace/reconstructCandidate.js';
import { runHiddenGrader } from './hiddenGrader.js';

let gradeCounter = 0;

export interface FixtureSelfTestInput {
  readonly fixture: FixtureDocument;
  readonly fixtureRoot: string;
  readonly seedRepositoryPath: string;
  readonly repositoryCommit: string;
  readonly repeatCount?: number;
  readonly workDir: string;
}

export interface FixtureSelfTestResult {
  readonly valid: boolean;
  readonly seedFails: boolean;
  readonly referencePasses: boolean;
  readonly mutationsFail: boolean;
  readonly flakeDetected: boolean;
  readonly graderMutatesCandidate: boolean;
  readonly messages: readonly string[];
}

async function gradePatch(
  input: FixtureSelfTestInput,
  patchPath: string | null,
  overlayIntegrity: 'unchanged' | 'tampered' = 'unchanged',
): Promise<GradeReport> {
  gradeCounter += 1;
  const gradingWorkspace = join(input.workDir, `grading-${String(gradeCounter)}`);
  const candidatePatchPath =
    patchPath ?? join(input.workDir, `empty-${String(gradeCounter)}.patch`);
  if (patchPath === null) {
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(input.workDir, { recursive: true });
    await writeFile(candidatePatchPath, '', 'utf8');
  }
  return runHiddenGrader({
    fixture: input.fixture,
    fixtureRoot: input.fixtureRoot,
    gradingWorkspaceRoot: gradingWorkspace,
    candidatePatchPath,
    overlayIntegrity,
    seedRepositoryPath: input.seedRepositoryPath,
    repositoryCommit: input.repositoryCommit,
  });
}

export async function runFixtureSelfTest(
  input: FixtureSelfTestInput,
): Promise<FixtureSelfTestResult> {
  gradeCounter = 0;
  const messages: string[] = [];
  const repeatCount = input.repeatCount ?? 3;

  const seedGrade = await gradePatch(input, null);
  const seedFails = seedGrade.status !== 'verified_success';
  if (!seedFails) {
    messages.push('seed unexpectedly passes');
  }

  let referencePasses = false;
  const solutionPatch = input.fixture.reference.solutionPatch;
  if (solutionPatch !== undefined) {
    const patchPath = join(input.fixtureRoot, solutionPatch);
    const refGrade = await gradePatch(input, patchPath);
    referencePasses = refGrade.status === 'verified_success';
    if (!referencePasses) {
      messages.push('reference solution fails');
    }
  } else {
    messages.push('no reference solution patch');
  }

  let mutationsFail = true;
  const mutations = input.fixture.reference.mutationCases ?? [];
  for (const mutationPath of mutations) {
    const patchPath = join(input.fixtureRoot, mutationPath);
    const mutationGrade = await gradePatch(input, patchPath);
    if (mutationGrade.status === 'verified_success') {
      mutationsFail = false;
      messages.push(`mutation unexpectedly passes: ${mutationPath}`);
    }
  }

  let flakeDetected = false;
  if (solutionPatch !== undefined) {
    const patchPath = join(input.fixtureRoot, solutionPatch);
    const statuses: string[] = [];
    for (let i = 0; i < repeatCount; i += 1) {
      const grade = await gradePatch(
        {
          ...input,
          workDir: join(input.workDir, `repeat-${String(i)}`),
        },
        patchPath,
      );
      statuses.push(grade.status);
    }
    const unique = new Set(statuses);
    if (unique.size > 1) {
      flakeDetected = true;
      messages.push('flake detected across repeats');
    }
  }

  let graderMutatesCandidate = false;
  if (solutionPatch !== undefined) {
    const patchPath = join(input.fixtureRoot, solutionPatch);
    const patch = await readFile(patchPath, 'utf8');
    const workspaceBefore = join(input.workDir, 'grader-mutation-check');
    const reconstructed = await reconstructCandidate({
      seedRepositoryPath: input.seedRepositoryPath,
      repositoryCommit: input.repositoryCommit,
      targetWorkspaceRoot: workspaceBefore,
      patchContent: patch,
      untrackedManifest: null,
      overlayPaths: [],
    });
    if (reconstructed.success) {
      const fpBefore = reconstructed.finalFingerprint;
      await gradePatch({ ...input, workDir: join(input.workDir, 'grader-check') }, patchPath);
      const fpAfter = await computeTreeFingerprint(workspaceBefore);
      if (fpBefore !== fpAfter) {
        graderMutatesCandidate = true;
        messages.push('grader mutates candidate workspace');
      }
    }
  }

  const valid =
    seedFails && referencePasses && mutationsFail && !flakeDetected && !graderMutatesCandidate;

  return {
    valid,
    seedFails,
    referencePasses,
    mutationsFail,
    flakeDetected,
    graderMutatesCandidate,
    messages,
  };
}
