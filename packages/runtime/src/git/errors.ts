export const GIT_ERROR_CODES = {
  SUBMODULES_UNSUPPORTED: 'GIT_SUBMODULES_UNSUPPORTED',
  LFS_UNSUPPORTED: 'GIT_LFS_UNSUPPORTED',
  INSPECT_FAILED: 'GIT_INSPECT_FAILED',
  CLONE_FAILED: 'GIT_CLONE_FAILED',
  CHECKOUT_FAILED: 'GIT_CHECKOUT_FAILED',
  CONFIG_FAILED: 'GIT_CONFIG_FAILED',
} as const;

export type GitErrorCode = (typeof GIT_ERROR_CODES)[keyof typeof GIT_ERROR_CODES];

/**
 * Typed error for git seed/clone operations. Mirrors the shape of `ArtifactError` so callers can
 * switch on `code` instead of parsing messages.
 */
export class GitRepositoryError extends Error {
  readonly code: GitErrorCode;

  constructor(code: GitErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'GitRepositoryError';
    this.code = code;
  }
}
