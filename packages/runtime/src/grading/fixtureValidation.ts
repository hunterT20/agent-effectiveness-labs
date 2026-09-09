import type { FixtureDocument, GradeReport } from '@ael/core';

import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { reconstructCandidate } from '../workspace/reconstructCandidate.js';
import { runHiddenGrader } from './hiddenGrader.js';

const HARNESS_DIR_NAMES = new Set(['.git', '.ael', 'grader']);

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

interface GradeOnceResult {
  readonly grade: GradeReport;
  readonly workspace: string;
}

async function walkCandidateFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      if (HARNESS_DIR_NAMES.has(entry.name)) {
        continue;
      }
      files.push(...(await walkCandidateFiles(root, fullPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(relative(root, fullPath));
    }
  }
  return files.sort();
}

/** Fingerprint the candidate tree a grader ran against, ignoring harness-only dirs. */
async function fingerprintGradingWorkspace(workspaceRoot: string): Promise<string> {
  const files = await walkCandidateFiles(workspaceRoot);
  const hash = createHash('sha256');
  for (const filePath of files) {
    const fullPath = join(workspaceRoot, filePath);
    const fileStat = await stat(fullPath);
    const content = await readFile(fullPath);
    hash.update(filePath);
    hash.update('\0');
    hash.update(String(fileStat.mode));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function runFixtureSelfTest(
  input: FixtureSelfTestInput,
): Promise<FixtureSelfTestResult> {
  const messages: string[] = [];
  const repeatCount = input.repeatCount ?? 3;
  const runId = randomUUID();
  let gradeSeq = 0;

  const nextLabel = (purpose: string): string => {
    gradeSeq += 1;
    return `${purpose}-${runId}-${String(gradeSeq)}`;
  };

  async function gradeOnce(
    patchPath: string | null,
    overlayIntegrity: 'unchanged' | 'tampered' = 'unchanged',
    candidateArtifactsDir?: string,
    purpose = 'grade',
  ): Promise<GradeOnceResult> {
    const label = nextLabel(purpose);
    const gradingWorkspace = join(input.workDir, label);
    const candidatePatchPath = patchPath ?? join(input.workDir, `${label}.patch`);
    if (patchPath === null) {
      await mkdir(input.workDir, { recursive: true });
      await writeFile(candidatePatchPath, '', 'utf8');
    }
    const grade = await runHiddenGrader({
      fixture: input.fixture,
      fixtureRoot: input.fixtureRoot,
      gradingWorkspaceRoot: gradingWorkspace,
      candidatePatchPath,
      ...(candidateArtifactsDir !== undefined ? { candidateArtifactsDir } : {}),
      overlayIntegrity,
      seedRepositoryPath: input.seedRepositoryPath,
      repositoryCommit: input.repositoryCommit,
    });
    return { grade, workspace: gradingWorkspace };
  }

  const seedGrade = await gradeOnce(null, 'unchanged', undefined, 'seed');
  const seedFails = seedGrade.grade.status !== 'verified_success';
  if (!seedFails) {
    messages.push('seed unexpectedly passes');
  }

  let referencePasses = false;
  let referenceWorkspace: string | undefined;
  let referencePatchContent = '';
  const solutionPatch = input.fixture.reference.solutionPatch;
  const artifactDirectory = input.fixture.reference.artifactDirectory;

  if (solutionPatch !== undefined) {
    const patchPath = join(input.fixtureRoot, solutionPatch);
    referencePatchContent = await readFile(patchPath, 'utf8');
    const refGrade = await gradeOnce(patchPath, 'unchanged', undefined, 'reference');
    referencePasses = refGrade.grade.status === 'verified_success';
    referenceWorkspace = refGrade.workspace;
    if (!referencePasses) {
      messages.push('reference solution fails');
    }
  } else if (artifactDirectory !== undefined) {
    const artifactsDir = join(input.fixtureRoot, artifactDirectory);
    const refGrade = await gradeOnce(null, 'unchanged', artifactsDir, 'reference');
    referencePasses = refGrade.grade.status === 'verified_success';
    referenceWorkspace = refGrade.workspace;
    if (!referencePasses) {
      messages.push('reference artifacts fail');
    }
  } else {
    messages.push('no reference solution patch or artifacts');
  }

  let mutationsFail = true;
  const mutations = input.fixture.reference.mutationCases ?? [];
  for (const mutationPath of mutations) {
    const fullPath = join(input.fixtureRoot, mutationPath);
    const mutationGrade = mutationPath.endsWith('.patch')
      ? await gradeOnce(fullPath, 'unchanged', undefined, 'mutation')
      : await gradeOnce(null, 'unchanged', fullPath, 'mutation');
    if (mutationGrade.grade.status === 'verified_success') {
      mutationsFail = false;
      messages.push(`mutation unexpectedly passes: ${mutationPath}`);
    }
  }

  let flakeDetected = false;
  if (solutionPatch !== undefined) {
    const patchPath = join(input.fixtureRoot, solutionPatch);
    const statuses: string[] = [];
    for (let i = 0; i < repeatCount; i += 1) {
      const grade = await gradeOnce(patchPath, 'unchanged', undefined, `repeat-${String(i)}`);
      statuses.push(grade.grade.status);
    }
    const unique = new Set(statuses);
    if (unique.size > 1) {
      flakeDetected = true;
      messages.push('flake detected across repeats');
    }
  } else if (artifactDirectory !== undefined) {
    const artifactsDir = join(input.fixtureRoot, artifactDirectory);
    const statuses: string[] = [];
    for (let i = 0; i < repeatCount; i += 1) {
      const grade = await gradeOnce(null, 'unchanged', artifactsDir, `repeat-${String(i)}`);
      statuses.push(grade.grade.status);
    }
    const unique = new Set(statuses);
    if (unique.size > 1) {
      flakeDetected = true;
      messages.push('flake detected across repeats');
    }
  }

  let graderMutatesCandidate = false;
  if (referencePasses && referenceWorkspace !== undefined) {
    const expectedRoot = join(input.workDir, nextLabel('mutation-expected'));
    const reconstructed = await reconstructCandidate({
      seedRepositoryPath: input.seedRepositoryPath,
      repositoryCommit: input.repositoryCommit,
      targetWorkspaceRoot: expectedRoot,
      patchContent: referencePatchContent,
      untrackedManifest: null,
      overlayPaths: [],
    });
    if (reconstructed.success) {
      if (artifactDirectory !== undefined) {
        await cp(join(input.fixtureRoot, artifactDirectory), expectedRoot, { recursive: true });
      }
      const fpBefore = await fingerprintGradingWorkspace(expectedRoot);
      const fpAfter = await fingerprintGradingWorkspace(referenceWorkspace);
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
