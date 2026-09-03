import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ARTIFACT_ERROR_CODES, ArtifactError } from './errors.js';
import { writeAtomicJson } from './atomicWrite.js';
import { resolveArtifactPath } from './paths.js';

export interface BlobReference {
  readonly hash: string;
  readonly path: string;
}

export class AttemptStore {
  constructor(private readonly experimentRoot: string) {}

  async createAttempt(trialId: string, attemptId: string, state: unknown): Promise<void> {
    const attemptDir = resolveArtifactPath(this.experimentRoot, `attempts/${trialId}/${attemptId}`);

    if (existsSync(attemptDir)) {
      throw new ArtifactError(
        ARTIFACT_ERROR_CODES.ATTEMPT_EXISTS,
        `Attempt already exists: ${trialId}/${attemptId}`,
      );
    }

    await mkdir(attemptDir, { recursive: true });
    await writeAtomicJson(join(attemptDir, 'state.json'), state);
  }

  async storeBlob(trialId: string, attemptId: string, content: Buffer): Promise<BlobReference> {
    const hash = createHash('sha256').update(content).digest('hex');
    const blobPath = resolveArtifactPath(
      this.experimentRoot,
      `attempts/${trialId}/${attemptId}/blobs/${hash}`,
    );

    await mkdir(dirname(blobPath), { recursive: true });
    if (!existsSync(blobPath)) {
      await writeFile(blobPath, content);
    }

    return { hash, path: blobPath };
  }
}
