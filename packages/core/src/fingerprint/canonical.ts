import { createHash } from 'node:crypto';

import { canonicalize } from 'json-canonicalize';

export function canonicalizeJson(value: unknown): string {
  return canonicalize(value);
}

export function computeFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalizeJson(value)).digest('hex');
}

export function fingerprintRecord(
  schemaName: string,
  schemaVersion: number,
  value: unknown,
): string {
  return computeFingerprint({
    schemaName,
    schemaVersion,
    value,
  });
}
