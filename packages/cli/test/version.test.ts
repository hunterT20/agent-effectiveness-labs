import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as cli from '@ael/cli';
import * as core from '@ael/core';
import * as reporter from '@ael/reporter';
import * as runtime from '@ael/runtime';

const testDir = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(testDir, '..', 'dist', 'index.js');

describe('ael --version', () => {
  it('exits 0 and prints a semver version', () => {
    const result = spawnSync(process.execPath, [cliEntry, '--version'], {
      encoding: 'utf8',
      shell: false,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('workspace entrypoints', () => {
  it('imports all package entrypoints', () => {
    expect(core.PACKAGE_NAME).toBe('@ael/core');
    expect(runtime.PACKAGE_NAME).toBe('@ael/runtime');
    expect(reporter.PACKAGE_NAME).toBe('@ael/reporter');
    expect(cli.PACKAGE_NAME).toBe('@ael/cli');
  });
});
