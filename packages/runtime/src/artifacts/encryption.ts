import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ARTIFACT_ERROR_CODES, ArtifactError } from './errors.js';
import { writeAtomicBytes, writeAtomicJson } from './atomicWrite.js';
import { resolveArtifactPath } from './paths.js';
import { PROTECTED_BLOB_ENVELOPE_VERSION, ProtectedBlobEnvelopeSchema } from './schemas.js';

export { PROTECTED_BLOB_ENVELOPE_VERSION };

export interface ProtectedBlobEnvelope {
  readonly schemaVersion: typeof PROTECTED_BLOB_ENVELOPE_VERSION;
  readonly algorithm: 'aes-256-gcm';
  readonly iv: string;
  readonly authTag: string;
  readonly plaintextSha256: string;
}

export interface RunKeySource {
  getRunKey(): Buffer;
}

export interface StoredProtectedBlob {
  readonly blobId: string;
  readonly envelope: ProtectedBlobEnvelope;
  readonly ciphertextPath: string;
}

export class ProtectedBlobStore {
  constructor(
    private readonly experimentRoot: string,
    private readonly runKeySource: RunKeySource,
  ) {}

  async encryptAndStore(plaintext: Buffer): Promise<StoredProtectedBlob> {
    const key = this.runKeySource.getRunKey();
    if (key.length !== 32) {
      throw new ArtifactError(
        ARTIFACT_ERROR_CODES.RUN_KEY_UNAVAILABLE,
        'Run key must be 32 bytes for aes-256-gcm',
      );
    }

    const iv = randomBytes(12);
    const probeCipher = createCipheriv('aes-256-gcm', key, iv);
    let ciphertext = Buffer.concat([probeCipher.update(plaintext), probeCipher.final()]);
    const blobId = createHash('sha256').update(ciphertext).digest('hex');

    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(blobId, 'hex'));
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const verifiedBlobId = createHash('sha256').update(ciphertext).digest('hex');
    if (verifiedBlobId !== blobId) {
      throw new ArtifactError(
        ARTIFACT_ERROR_CODES.DECRYPTION_FAILED,
        'Protected blob content-address mismatch after AAD binding',
      );
    }

    const plaintextSha256 = createHash('sha256').update(plaintext).digest('hex');

    const envelope: ProtectedBlobEnvelope = {
      schemaVersion: PROTECTED_BLOB_ENVELOPE_VERSION,
      algorithm: 'aes-256-gcm',
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      plaintextSha256,
    };

    const privateDir = resolveArtifactPath(this.experimentRoot, 'private-blobs');
    await mkdir(privateDir, { recursive: true });
    const ciphertextPath = join(privateDir, blobId);
    const envelopePath = join(privateDir, `${blobId}.envelope.json`);

    await writeAtomicBytes(ciphertextPath, ciphertext);
    await writeAtomicJson(envelopePath, envelope);

    return { blobId, envelope, ciphertextPath };
  }

  async decrypt(blobId: string, envelope: unknown): Promise<Buffer> {
    const validatedEnvelope = this.parseEnvelope(envelope);

    let key: Buffer;
    try {
      key = this.runKeySource.getRunKey();
    } catch (error) {
      throw new ArtifactError(ARTIFACT_ERROR_CODES.RUN_KEY_UNAVAILABLE, 'Run key is unavailable', {
        cause: error,
      });
    }

    if (key.length !== 32) {
      throw new ArtifactError(
        ARTIFACT_ERROR_CODES.RUN_KEY_UNAVAILABLE,
        'Run key must be 32 bytes for aes-256-gcm',
      );
    }

    const ciphertextPath = resolveArtifactPath(this.experimentRoot, `private-blobs/${blobId}`);
    const ciphertext = await readFile(ciphertextPath);

    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(validatedEnvelope.iv, 'hex'),
      );
      decipher.setAAD(Buffer.from(blobId, 'hex'));
      decipher.setAuthTag(Buffer.from(validatedEnvelope.authTag, 'hex'));
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const plaintextSha256 = createHash('sha256').update(plaintext).digest('hex');
      if (plaintextSha256 !== validatedEnvelope.plaintextSha256) {
        throw new ArtifactError(
          ARTIFACT_ERROR_CODES.DECRYPTION_FAILED,
          'Decrypted plaintext hash mismatch',
        );
      }
      return plaintext;
    } catch (error) {
      if (error instanceof ArtifactError) {
        throw error;
      }
      throw new ArtifactError(
        ARTIFACT_ERROR_CODES.DECRYPTION_FAILED,
        'Protected blob decryption failed',
        { cause: error },
      );
    }
  }

  private parseEnvelope(envelope: unknown): ProtectedBlobEnvelope {
    const result = ProtectedBlobEnvelopeSchema.safeParse(envelope);
    if (!result.success) {
      throw new ArtifactError(
        ARTIFACT_ERROR_CODES.INVALID_ENVELOPE,
        'Protected blob envelope is invalid',
        { cause: result.error },
      );
    }
    return result.data;
  }
}
