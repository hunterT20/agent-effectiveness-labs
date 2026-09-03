import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  areProtectionsEnabled,
  setProtectionsEnabled,
} from '../../packages/runtime/src/security/protectionSeam.js';
import { isInside } from '@ael/core';

describe('adversarial protection seam', () => {
  it('fault injection: protection disabled allows path escape detection to fail', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ael-adv-'));
    const outside = mkdtempSync(join(tmpdir(), 'ael-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'leaked\n', 'utf8');

    setProtectionsEnabled(true);
    expect(isInside(outside, workspace)).toBe(false);

    setProtectionsEnabled(false);
    const protectionOff = areProtectionsEnabled();
    expect(protectionOff).toBe(false);

    setProtectionsEnabled(true);
    expect(areProtectionsEnabled()).toBe(true);
  });
});

describe('adversarial threats', () => {
  it('hidden grader path is not inside candidate workspace by default', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ael-grader-'));
    const graderRoot = join(workspace, 'grader');
    mkdirSync(graderRoot, { recursive: true });
    writeFileSync(join(graderRoot, 'check.mjs'), 'process.exit(0)', 'utf8');
    const candidateOnly = join(workspace, 'src');
    expect(isInside(graderRoot, candidateOnly)).toBe(false);
  });

  it('overlay tamper detection flags modified overlay fingerprint', async () => {
    const { readOverlayManifest } = await import('../../packages/runtime/src/arms/builtin.js');
    const { computeTreeFingerprint } =
      await import('../../packages/runtime/src/git/fingerprint.js');
    const workspace = mkdtempSync(join(tmpdir(), 'ael-overlay-'));
    writeFileSync(join(workspace, 'overlay-marker.txt'), 'original\n', 'utf8');
    const manifestPath = join(workspace, 'overlay.json');
    const fp = await computeTreeFingerprint(workspace);
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ overlayPaths: ['overlay-marker.txt'], fingerprint: fp })}\n`,
    );
    writeFileSync(join(workspace, 'overlay-marker.txt'), 'tampered\n', 'utf8');
    const manifest = await readOverlayManifest(manifestPath);
    const currentFp = await computeTreeFingerprint(workspace);
    expect(currentFp).not.toBe(manifest.fingerprint);
  });

  it('secret patterns should not appear in redacted output', async () => {
    const { redactSecrets } = await import('../../packages/runtime/src/process/redaction.js');
    const output = redactSecrets('api_key=super-secret-token\n');
    expect(output.includes('super-secret-token')).toBe(false);
  });
});
