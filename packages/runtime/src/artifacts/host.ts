import { createHash } from 'node:crypto';
import { hostname } from 'node:os';

export function computeHostFingerprint(): string {
  return createHash('sha256').update(hostname()).digest('hex').slice(0, 16);
}
