/**
 * Process exit contract for the `ael` CLI (M1.12).
 *
 * | Code | Constant          | Meaning                                                         |
 * | ---- | ----------------- | --------------------------------------------------------------- |
 * | 0    | EXIT_OK           | Success                                                         |
 * | 2    | EXIT_CONFIG       | Invalid config, Zod-invalid sealed plan, or missing plan files  |
 * | 3    | EXIT_CAPABILITY   | Adapter/isolation gap, missing binary, or live run unapproved   |
 * | 4    | EXIT_RUNTIME      | Runtime failure after a valid, approved plan                    |
 * | 5    | EXIT_VERDICT_FAIL | Report verdict is not PASSED (`--fail-on-verdict`)              |
 *
 * Human-readable text goes to stderr. Machine-readable JSON (`--json`) goes to stdout.
 */
export const EXIT_OK = 0;
export const EXIT_CONFIG = 2;
export const EXIT_CAPABILITY = 3;
export const EXIT_RUNTIME = 4;
export const EXIT_VERDICT_FAIL = 5;
