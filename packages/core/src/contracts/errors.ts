import type { AelErrorCode } from './error-codes.js';

export class ConfigValidationError extends Error {
  readonly code: AelErrorCode;
  readonly filePath: string;
  readonly fieldPath: string;

  constructor(
    message: string,
    options: {
      code: AelErrorCode;
      filePath: string;
      fieldPath: string;
      cause?: unknown;
    },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ConfigValidationError';
    this.code = options.code;
    this.filePath = options.filePath;
    this.fieldPath = options.fieldPath;
  }
}
