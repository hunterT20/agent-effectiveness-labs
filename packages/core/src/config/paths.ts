import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { isInside } from '../fs/containment.js';
import { CONFIG_LOAD_ERROR_CODES, ConfigLoadError } from './errors.js';

function assertPathContained(
  manifestDir: string,
  relativePath: string,
  resolvedPath: string,
  containedRoot: string,
  code: (typeof CONFIG_LOAD_ERROR_CODES)[keyof typeof CONFIG_LOAD_ERROR_CODES],
  message: string,
): void {
  if (!isInside(resolvedPath, containedRoot)) {
    throw new ConfigLoadError(message, {
      code,
      manifestDir,
      relativePath,
    });
  }
}

export function resolveContainedPath(manifestDir: string, relativePath: string): string {
  const resolvedManifestDir = resolve(manifestDir);
  const resolvedPath = resolve(resolvedManifestDir, relativePath);

  assertPathContained(
    resolvedManifestDir,
    relativePath,
    resolvedPath,
    resolvedManifestDir,
    CONFIG_LOAD_ERROR_CODES.PATH_ESCAPE,
    `Rejected path escape outside manifest directory: ${relativePath}`,
  );

  try {
    const realPath = realpathSync(resolvedPath);
    assertPathContained(
      resolvedManifestDir,
      relativePath,
      realPath,
      resolvedManifestDir,
      CONFIG_LOAD_ERROR_CODES.SYMLINK_ESCAPE,
      `Rejected symlink escape outside manifest directory: ${relativePath}`,
    );
  } catch (error) {
    if (error instanceof ConfigLoadError) {
      throw error;
    }

    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return resolvedPath;
    }

    throw error;
  }

  return resolvedPath;
}

export function manifestDirectory(manifestPath: string): string {
  return resolve(dirname(manifestPath));
}
