import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigLoadError, manifestDirectory, resolveContainedPath } from '@ael/core';

describe('resolveContainedPath', () => {
  it('resolves a relative path within the manifest directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'ael-path-'));
    const manifestDir = join(root, 'suite');
    mkdirSync(manifestDir, { recursive: true });

    const resolved = resolveContainedPath(manifestDir, './arms/baseline.yaml');

    expect(resolved).toBe(join(realpathSync(manifestDir), 'arms/baseline.yaml'));
  });

  it('rejects path escape outside the manifest directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'ael-path-'));
    const manifestDir = join(root, 'suite');
    mkdirSync(manifestDir, { recursive: true });

    expect(() => resolveContainedPath(manifestDir, '../../../outside.yaml')).toThrow(
      ConfigLoadError,
    );
    expect(() => resolveContainedPath(manifestDir, '../../../outside.yaml')).toThrow(
      /path escape/i,
    );
  });

  it('rejects symlink escape outside the manifest directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'ael-path-'));
    const manifestDir = join(root, 'suite');
    const outsideDir = join(root, 'outside');
    mkdirSync(manifestDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'secret.yaml'), 'schemaVersion: 1\n', 'utf8');
    symlinkSync(join(outsideDir, 'secret.yaml'), join(manifestDir, 'link.yaml'));

    expect(() => resolveContainedPath(manifestDir, './link.yaml')).toThrow(ConfigLoadError);
    expect(() => resolveContainedPath(manifestDir, './link.yaml')).toThrow(/symlink escape/i);
  });

  it('realpaths the manifest directory so /var and /private/var match on macOS', () => {
    const root = mkdtempSync(join(tmpdir(), 'ael-path-'));
    const manifestDir = join(root, 'suite');
    mkdirSync(manifestDir, { recursive: true });
    expect(manifestDirectory(join(manifestDir, 'suite.yaml'))).toBe(realpathSync(manifestDir));
  });
});
