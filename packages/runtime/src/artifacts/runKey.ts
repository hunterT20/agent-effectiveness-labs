import { readFileSync } from 'node:fs';

import { ARTIFACT_ERROR_CODES, ArtifactError } from './errors.js';
import type { RunKeySource } from './encryption.js';

export function createRunKeySourceFromEnv(): RunKeySource {
  const keyFile = process.env.AEL_RUN_KEY_FILE;
  if (keyFile === undefined || keyFile.length === 0) {
    throw new ArtifactError(
      ARTIFACT_ERROR_CODES.RUN_KEY_UNAVAILABLE,
      'AEL_RUN_KEY_FILE is not set',
    );
  }
  return {
    getRunKey: () => {
      const raw = readFileSync(keyFile, 'utf8').trim();
      const key = Buffer.from(raw, 'hex');
      if (key.length !== 32) {
        throw new ArtifactError(
          ARTIFACT_ERROR_CODES.RUN_KEY_UNAVAILABLE,
          'Run key from AEL_RUN_KEY_FILE must be 32 bytes hex',
        );
      }
      return key;
    },
  };
}

export function createRunKeySourceFromHex(hex: string): RunKeySource {
  return {
    getRunKey: () => {
      const key = Buffer.from(hex, 'hex');
      if (key.length !== 32) {
        throw new ArtifactError(
          ARTIFACT_ERROR_CODES.RUN_KEY_UNAVAILABLE,
          'Run key must be 32 bytes hex',
        );
      }
      return key;
    },
  };
}
