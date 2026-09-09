import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { isInside } from '@ael/core';

import { ARTIFACT_ERROR_CODES, ArtifactError } from './errors.js';

function resolveOutputRoot(outputRoot: string): string {
  const resolved = resolve(outputRoot);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function assertContained(
  outputRoot: string,
  relativePath: string,
  resolvedPath: string,
  code: (typeof ARTIFACT_ERROR_CODES)[keyof typeof ARTIFACT_ERROR_CODES],
  message: string,
): void {
  if (!isInside(resolvedPath, outputRoot)) {
    throw new ArtifactError(code, message);
  }
}

export function resolveArtifactPath(outputRoot: string, relativePath: string): string {
  const resolvedOutputRoot = resolveOutputRoot(outputRoot);
  const resolvedPath = resolve(resolvedOutputRoot, relativePath);

  assertContained(
    resolvedOutputRoot,
    relativePath,
    resolvedPath,
    ARTIFACT_ERROR_CODES.PATH_ESCAPE,
    `Rejected artifact path escape outside output root: ${relativePath}`,
  );

  try {
    const realPath = realpathSync(resolvedPath);
    assertContained(
      resolvedOutputRoot,
      relativePath,
      realPath,
      ARTIFACT_ERROR_CODES.SYMLINK_ESCAPE,
      `Rejected artifact symlink escape outside output root: ${relativePath}`,
    );
    return realPath;
  } catch (error) {
    if (error instanceof ArtifactError) {
      throw error;
    }

    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return resolvedPath;
    }

    throw error;
  }
}

export interface ForbiddenRoots {
  readonly sourceRoot: string;
  readonly fixtureRoots: readonly string[];
  readonly candidateRoots: readonly string[];
  readonly agentVisibleRoots: readonly string[];
}

export function validateOutputRoot(outputRoot: string, forbidden: ForbiddenRoots): void {
  const resolvedOutput = resolve(outputRoot);
  const forbiddenRoots = [
    forbidden.sourceRoot,
    ...forbidden.fixtureRoots,
    ...forbidden.candidateRoots,
    ...forbidden.agentVisibleRoots,
  ];

  for (const forbiddenRoot of forbiddenRoots) {
    const resolvedForbidden = resolve(forbiddenRoot);
    if (isInside(resolvedOutput, resolvedForbidden)) {
      throw new ArtifactError(
        ARTIFACT_ERROR_CODES.OUTPUT_ROOT_FORBIDDEN,
        `Rejected output root inside forbidden root: ${resolvedOutput} is inside ${resolvedForbidden}`,
      );
    }
  }
}
