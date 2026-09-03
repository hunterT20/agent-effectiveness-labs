import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ArtifactError, ProtectedBlobStore, type RunKeySource } from '@ael/runtime';

const RUN_KEY_HEX = 'a'.repeat(64);

function createRunKeySource(keyHex: string | null): RunKeySource {
  return {
    getRunKey: () => {
      if (keyHex === null) {
        throw new ArtifactError('RUN_KEY_UNAVAILABLE', 'Run key is unavailable');
      }
      return Buffer.from(keyHex, 'hex');
    },
  };
}

function collectTextUnder(dir: string): string {
  const entries = readdirSync(dir, { withFileTypes: true, recursive: true });
  const chunks: string[] = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      chunks.push(readFileSync(join(entry.parentPath ?? dir, entry.name), 'utf8'));
    }
  }
  return chunks.join('\n');
}

describe('protected candidate blobs', () => {
  it('round-trips exact candidate blobs through authenticated encryption', async () => {
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-encrypt-'));
    const store = new ProtectedBlobStore(experimentRoot, createRunKeySource(RUN_KEY_HEX));
    const plaintext = Buffer.from('exact-candidate-secret-material');

    const stored = await store.encryptAndStore(plaintext);
    const decrypted = await store.decrypt(stored.blobId, stored.envelope);

    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it('fails closed on ciphertext tampering and missing run key', async () => {
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-encrypt-'));
    const store = new ProtectedBlobStore(experimentRoot, createRunKeySource(RUN_KEY_HEX));
    const plaintext = Buffer.from('tamper-me');
    const stored = await store.encryptAndStore(plaintext);

    const ciphertext = await readFile(stored.ciphertextPath);
    const tampered = Buffer.from(ciphertext);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(stored.ciphertextPath, tampered),
    );

    await expect(store.decrypt(stored.blobId, stored.envelope)).rejects.toThrow(ArtifactError);

    const missingKeyStore = new ProtectedBlobStore(experimentRoot, createRunKeySource(null));
    await expect(missingKeyStore.decrypt(stored.blobId, stored.envelope)).rejects.toThrow(
      ArtifactError,
    );
  });

  it('never persists the run key or plaintext protected blob in public artifacts', async () => {
    const experimentRoot = mkdtempSync(join(tmpdir(), 'ael-encrypt-'));
    const store = new ProtectedBlobStore(experimentRoot, createRunKeySource(RUN_KEY_HEX));
    const plaintext = Buffer.from('never-leak-this-candidate-blob');
    const logs: string[] = [];

    const originalLog = console.log.bind(console);
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
      originalLog(...args);
    };

    try {
      await store.encryptAndStore(plaintext);
    } finally {
      console.log = originalLog;
    }

    const publicText = collectTextUnder(experimentRoot);
    const logText = logs.join('\n');

    expect(publicText.includes(RUN_KEY_HEX)).toBe(false);
    expect(publicText.includes(plaintext.toString('utf8'))).toBe(false);
    expect(logText.includes(RUN_KEY_HEX)).toBe(false);
    expect(logText.includes(plaintext.toString('utf8'))).toBe(false);
  });
});
