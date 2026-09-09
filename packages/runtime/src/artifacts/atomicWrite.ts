import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { z } from 'zod';

import { ARTIFACT_ERROR_CODES, ArtifactError } from './errors.js';

export interface AtomicWriteOptions {
  readonly injectFailure?: 'before-rename' | 'after-rename';
}

export async function writeAtomicJson(
  targetPath: string,
  value: unknown,
  options?: AtomicWriteOptions,
): Promise<void> {
  const directory = dirname(targetPath);
  await mkdir(directory, { recursive: true });

  const tempPath = join(directory, `.${randomBytes(8).toString('hex')}.tmp`);
  const payload = `${JSON.stringify(value, null, 2)}\n`;

  const tempHandle = await open(tempPath, 'w');
  try {
    await tempHandle.writeFile(payload, 'utf8');
    await tempHandle.sync();
  } finally {
    await tempHandle.close();
  }

  if (options?.injectFailure === 'before-rename') {
    await unlink(tempPath).catch(() => undefined);
    throw new ArtifactError(
      ARTIFACT_ERROR_CODES.ATOMIC_WRITE_FAILED,
      'Injected failure before rename',
    );
  }

  await rename(tempPath, targetPath);

  const directoryHandle = await open(directory, 'r');
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }

  if (options?.injectFailure === 'after-rename') {
    throw new ArtifactError(
      ARTIFACT_ERROR_CODES.ATOMIC_WRITE_FAILED,
      'Injected failure after rename',
    );
  }
}

export async function writeAtomicBytes(targetPath: string, data: Buffer): Promise<void> {
  const directory = dirname(targetPath);
  await mkdir(directory, { recursive: true });

  const tempPath = join(directory, `.${randomBytes(8).toString('hex')}.tmp`);
  const tempHandle = await open(tempPath, 'w');
  try {
    await tempHandle.writeFile(data);
    await tempHandle.sync();
  } finally {
    await tempHandle.close();
  }

  await rename(tempPath, targetPath);

  const directoryHandle = await open(directory, 'r');
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

export async function readAtomicJson<T>(targetPath: string, zodSchema: z.ZodType<T>): Promise<T> {
  const raw = await readFile(targetPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ArtifactError(ARTIFACT_ERROR_CODES.INVALID_JSON, `Invalid JSON at ${targetPath}`, {
      cause: error,
    });
  }

  const result = zodSchema.safeParse(parsed);
  if (!result.success) {
    throw new ArtifactError(
      ARTIFACT_ERROR_CODES.INVALID_JSON,
      `JSON schema validation failed at ${targetPath}`,
      { cause: result.error },
    );
  }

  return result.data;
}
