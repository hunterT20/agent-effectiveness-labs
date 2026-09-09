export const ARTIFACT_ERROR_CODES = {
  PATH_ESCAPE: 'ARTIFACT_PATH_ESCAPE',
  SYMLINK_ESCAPE: 'ARTIFACT_SYMLINK_ESCAPE',
  OUTPUT_ROOT_FORBIDDEN: 'ARTIFACT_OUTPUT_ROOT_FORBIDDEN',
  ATOMIC_WRITE_FAILED: 'ARTIFACT_ATOMIC_WRITE_FAILED',
  LOCK_HELD: 'ARTIFACT_LOCK_HELD',
  STALE_LOCK_RECOVERY_REQUIRED: 'ARTIFACT_STALE_LOCK_RECOVERY_REQUIRED',
  ATTEMPT_EXISTS: 'ARTIFACT_ATTEMPT_EXISTS',
  DECRYPTION_FAILED: 'ARTIFACT_DECRYPTION_FAILED',
  RUN_KEY_UNAVAILABLE: 'ARTIFACT_RUN_KEY_UNAVAILABLE',
  INVALID_ENVELOPE: 'ARTIFACT_INVALID_ENVELOPE',
  INVALID_JSON: 'ARTIFACT_INVALID_JSON',
} as const;

export type ArtifactErrorCode = (typeof ARTIFACT_ERROR_CODES)[keyof typeof ARTIFACT_ERROR_CODES];

export class ArtifactError extends Error {
  readonly code: ArtifactErrorCode;

  constructor(code: ArtifactErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ArtifactError';
    this.code = code;
  }
}
