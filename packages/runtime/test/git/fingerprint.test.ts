import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { computeTreeFingerprint, readTreeManifest } from '../../src/git/fingerprint.js';

const isWindows = process.platform === 'win32';
const tempDirs: string[] = [];

function tempTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ael-fp-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'empty-dir'));
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  writeFileSync(join(dir, 'src', 'a.txt'), 'a\n');
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('computeTreeFingerprint', () => {
  it('is stable for identical trees and ignores .git and empty directories', async () => {
    const a = tempTree();
    const b = tempTree();
    mkdirSync(join(b, 'another-empty'));
    writeFileSync(join(b, '.git', 'HEAD'), 'ref: refs/heads/other\n');
    expect(await computeTreeFingerprint(a)).toBe(await computeTreeFingerprint(b));
  });

  it('changes when content changes', async () => {
    const dir = tempTree();
    const before = await computeTreeFingerprint(dir);
    writeFileSync(join(dir, 'src', 'a.txt'), 'b\n');
    expect(await computeTreeFingerprint(dir)).not.toBe(before);
  });

  it.skipIf(isWindows)('changes when the executable bit changes', async () => {
    const dir = tempTree();
    const before = await computeTreeFingerprint(dir);
    chmodSync(join(dir, 'src', 'a.txt'), 0o755);
    expect(await computeTreeFingerprint(dir)).not.toBe(before);
  });

  it.skipIf(isWindows)(
    'includes symlinks by target string and changes when the target changes',
    async () => {
      const dir = tempTree();
      const plain = await computeTreeFingerprint(dir);

      symlinkSync('README.md', join(dir, 'link'));
      const withLink = await computeTreeFingerprint(dir);
      expect(withLink).not.toBe(plain);

      const manifest = await readTreeManifest(dir);
      expect(manifest.map((entry) => entry.path)).toEqual(['README.md', 'link', 'src/a.txt']);
      const link = manifest.find((entry) => entry.kind === 'symlink');
      expect(link).toMatchObject({ kind: 'symlink', path: 'link', target: 'README.md' });

      rmSync(join(dir, 'link'));
      symlinkSync('src/a.txt', join(dir, 'link'));
      const retargeted = await computeTreeFingerprint(dir);
      expect(retargeted).not.toBe(withLink);
      expect(retargeted).not.toBe(plain);
    },
  );

  it.skipIf(isWindows)(
    'does not follow symlinks (a dangling link is still fingerprinted)',
    async () => {
      const dir = tempTree();
      symlinkSync('does-not-exist', join(dir, 'dangling'));
      const fingerprint = await computeTreeFingerprint(dir);
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    },
  );
});
