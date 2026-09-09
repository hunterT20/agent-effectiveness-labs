import { createHash } from 'node:crypto';
import { existsSync, type Dirent } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ARTIFACT_ERROR_CODES, ArtifactError } from './errors.js';
import { readAtomicJson, writeAtomicJson } from './atomicWrite.js';
import { resolveArtifactPath } from './paths.js';
import {
  AttemptProvenanceSchema,
  AttemptStateSchema,
  type AttemptProvenance,
  type AttemptState,
} from './schemas.js';

export interface BlobReference {
  readonly hash: string;
  readonly path: string;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAttemptState(trialId: string, attemptId: string, state: unknown): AttemptState {
  if (!isJsonObject(state)) {
    throw new ArtifactError(
      ARTIFACT_ERROR_CODES.INVALID_JSON,
      `Attempt state must be a JSON object for ${trialId}/${attemptId}`,
    );
  }
  const parsed = AttemptStateSchema.safeParse({
    ...state,
    trialId,
    attemptId,
  });
  if (!parsed.success) {
    throw new ArtifactError(
      ARTIFACT_ERROR_CODES.INVALID_JSON,
      `Attempt state failed schema validation for ${trialId}/${attemptId}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
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

    const parsed = parseAttemptState(trialId, attemptId, state);
    await mkdir(attemptDir, { recursive: true });
    await writeAtomicJson(join(attemptDir, 'state.json'), parsed);
  }

  /** Lists attempt ids (directory names) recorded for a trial, sorted lexicographically. */
  async listAttemptIds(trialId: string): Promise<string[]> {
    const trialDir = resolveArtifactPath(this.experimentRoot, `attempts/${trialId}`);
    let entries: Dirent[];
    try {
      entries = await readdir(trialDir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return [];
      }
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  /** Reads and validates `state.json` for an attempt. Throws `ArtifactError` on invalid content. */
  async readAttemptState(trialId: string, attemptId: string): Promise<AttemptState> {
    const statePath = resolveArtifactPath(
      this.experimentRoot,
      `attempts/${trialId}/${attemptId}/state.json`,
    );
    try {
      return await readAtomicJson(statePath, AttemptStateSchema);
    } catch (error) {
      if (error instanceof ArtifactError) {
        throw error;
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new ArtifactError(
          ARTIFACT_ERROR_CODES.INVALID_JSON,
          `Attempt state not found for ${trialId}/${attemptId}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  /** Reads runner-owned provenance for an attempt, or `null` when it was never recorded. */
  async readAttemptProvenance(
    trialId: string,
    attemptId: string,
  ): Promise<AttemptProvenance | null> {
    const provenancePath = resolveArtifactPath(
      this.experimentRoot,
      `attempts/${trialId}/${attemptId}/provenance.json`,
    );
    if (!existsSync(provenancePath)) {
      return null;
    }
    return readAtomicJson(provenancePath, AttemptProvenanceSchema);
  }

  async writeAttemptProvenance(provenance: AttemptProvenance): Promise<void> {
    const parsed = AttemptProvenanceSchema.safeParse(provenance);
    if (!parsed.success) {
      throw new ArtifactError(
        ARTIFACT_ERROR_CODES.INVALID_JSON,
        `Attempt provenance failed schema validation for ${provenance.trialId}/${provenance.attemptId}`,
        { cause: parsed.error },
      );
    }
    const provenancePath = resolveArtifactPath(
      this.experimentRoot,
      `attempts/${parsed.data.trialId}/${parsed.data.attemptId}/provenance.json`,
    );
    await writeAtomicJson(provenancePath, parsed.data);
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
