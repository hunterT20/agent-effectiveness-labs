import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isInside } from '@ael/core';

describe('isInside (posix)', () => {
  it('accepts the parent directory itself', () => {
    expect(isInside('/var/data', '/var/data')).toBe(true);
  });

  it('accepts a nested child path', () => {
    expect(isInside('/var/data/output/lock.json', '/var/data')).toBe(true);
  });

  it('rejects a sibling path that shares a prefix', () => {
    expect(isInside('/var/data-backup', '/var/data')).toBe(false);
  });

  it('rejects path escape via dot segments', () => {
    expect(isInside('/var/data/../etc/passwd', '/var/data')).toBe(false);
  });
});

describe('isInside (win32)', () => {
  const win32 = path.win32;

  it('accepts nested paths on the same drive', () => {
    expect(isInside(win32.join('C:\\data', 'output', 'lock.json'), 'C:\\data')).toBe(true);
  });

  it('rejects sibling paths that share a drive prefix', () => {
    expect(isInside('C:\\data-backup', 'C:\\data')).toBe(false);
  });

  it('rejects traversal outside the parent on Windows', () => {
    expect(isInside(win32.join('C:\\data', '..', 'Windows'), 'C:\\data')).toBe(false);
  });
});
