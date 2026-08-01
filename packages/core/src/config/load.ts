import { readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';

import { parseSuiteDocument, type SuiteDocument } from './schemas.js';
import { manifestDirectory, resolveContainedPath } from './paths.js';

export interface ResolvedReference {
  readonly relativePath: string;
  readonly sourcePath: string;
}

export interface AuditedConfig<T> {
  readonly sourcePath: string;
  readonly manifestDir: string;
  readonly normalizedValue: T;
}

export interface LoadedSuiteManifest extends AuditedConfig<SuiteDocument> {
  readonly references: {
    readonly arms: readonly ResolvedReference[];
    readonly fixtures: readonly ResolvedReference[];
    readonly repository: ResolvedReference;
  };
}

function readYamlManifest(filePath: string): unknown {
  const raw = readFileSync(filePath, 'utf8');
  return parseYaml(raw);
}

function resolveReference(manifestDir: string, relativePath: string): ResolvedReference {
  return {
    relativePath,
    sourcePath: resolveContainedPath(manifestDir, relativePath),
  };
}

export function loadSuiteManifest(filePath: string): LoadedSuiteManifest {
  const manifestDir = manifestDirectory(filePath);
  const parsed = readYamlManifest(filePath);
  const normalizedValue = parseSuiteDocument(parsed, filePath);

  return {
    sourcePath: filePath,
    manifestDir,
    normalizedValue,
    references: {
      arms: normalizedValue.arms.map((relativePath) => resolveReference(manifestDir, relativePath)),
      fixtures: normalizedValue.fixtures.map((relativePath) =>
        resolveReference(manifestDir, relativePath),
      ),
      repository: resolveReference(manifestDir, normalizedValue.repository.path),
    },
  };
}
