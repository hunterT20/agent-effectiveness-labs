import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { cloneDetachedRepository, computeTreeFingerprint } from '../git/index.js';

export interface SeedWorkspaceInput {
  readonly sourceRepositoryPath: string;
  readonly commit: string;
  readonly trialRoot: string;
}

export interface SeedWorkspaceResult {
  readonly workspaceRoot: string;
  readonly baseFingerprint: string;
}

export async function seedWorkspace(input: SeedWorkspaceInput): Promise<SeedWorkspaceResult> {
  const workspaceRoot = join(input.trialRoot, 'workspace');
  await mkdir(input.trialRoot, { recursive: true });
  await cloneDetachedRepository({
    sourcePath: input.sourceRepositoryPath,
    targetPath: workspaceRoot,
    commit: input.commit,
  });
  const baseFingerprint = await computeTreeFingerprint(workspaceRoot);
  return { workspaceRoot, baseFingerprint };
}
