import type { AelErrorCode } from './error-codes.js';

export interface ConfigValidationIssue {
  readonly fieldPath: string;
  readonly code: AelErrorCode;
  readonly message: string;
}

export class ConfigValidationError extends Error {
  readonly code: AelErrorCode;
  readonly filePath: string;
  readonly fieldPath: string;
  readonly issues: readonly ConfigValidationIssue[];

  constructor(
    message: string,
    options: {
      code: AelErrorCode;
      filePath: string;
      fieldPath: string;
      issues: readonly ConfigValidationIssue[];
      cause?: unknown;
    },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ConfigValidationError';
    this.code = options.code;
    this.filePath = options.filePath;
    this.fieldPath = options.fieldPath;
    this.issues = options.issues;
  }
}
