import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ArtifactError, readAtomicJson, writeAtomicJson } from '@ael/runtime';

const StateSchema = z.object({
  schemaVersion: z.number(),
  status: z.string(),
});

describe('atomic JSON writes', () => {
  it('writes JSON atomically and reads it back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ael-atomic-'));
    const targetPath = join(dir, 'state.json');

    await writeAtomicJson(targetPath, { schemaVersion: 1, status: 'running' });
    const parsed = await readAtomicJson(targetPath, StateSchema);

    expect(parsed).toEqual({ schemaVersion: 1, status: 'running' });
  });

  it('survives injected failure before rename without corrupting the prior file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ael-atomic-'));
    const targetPath = join(dir, 'state.json');
    writeFileSync(targetPath, JSON.stringify({ schemaVersion: 1, status: 'original' }), 'utf8');

    await expect(
      writeAtomicJson(
        targetPath,
        { schemaVersion: 1, status: 'updated' },
        { injectFailure: 'before-rename' },
      ),
    ).rejects.toThrow(ArtifactError);

    const onDisk = JSON.parse(readFileSync(targetPath, 'utf8')) as { status: string };
    expect(onDisk.status).toBe('original');
  });

  it('survives injected failure after rename with a complete new file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ael-atomic-'));
    const targetPath = join(dir, 'state.json');
    writeFileSync(targetPath, JSON.stringify({ schemaVersion: 1, status: 'original' }), 'utf8');

    await expect(
      writeAtomicJson(
        targetPath,
        { schemaVersion: 1, status: 'updated' },
        { injectFailure: 'after-rename' },
      ),
    ).rejects.toThrow(ArtifactError);

    const onDisk = JSON.parse(readFileSync(targetPath, 'utf8')) as { status: string };
    expect(onDisk.status).toBe('updated');
  });
});
