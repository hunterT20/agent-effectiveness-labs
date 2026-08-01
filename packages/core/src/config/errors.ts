export const CONFIG_LOAD_ERROR_CODES = {
  PATH_ESCAPE: 'AEL_CONFIG_PATH_ESCAPE',
  SYMLINK_ESCAPE: 'AEL_CONFIG_SYMLINK_ESCAPE',
} as const;

export type ConfigLoadErrorCode =
  (typeof CONFIG_LOAD_ERROR_CODES)[keyof typeof CONFIG_LOAD_ERROR_CODES];

export class ConfigLoadError extends Error {
  readonly code: ConfigLoadErrorCode;
  readonly manifestDir: string;
  readonly relativePath: string;

  constructor(
    message: string,
    options: {
      code: ConfigLoadErrorCode;
      manifestDir: string;
      relativePath: string;
      cause?: unknown;
    },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ConfigLoadError';
    this.code = options.code;
    this.manifestDir = options.manifestDir;
    this.relativePath = options.relativePath;
  }
}
