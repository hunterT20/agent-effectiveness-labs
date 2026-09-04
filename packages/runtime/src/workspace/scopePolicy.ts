import { z } from 'zod';

/**
 * Minimal glob matcher for fixture scope policies.
 *
 * Supported syntax (POSIX separators, matched against workspace-relative paths):
 * - `**`  matches zero or more path segments
 * - `*`   matches any run of characters except `/`
 * - `?`   matches a single character except `/`
 * - a pattern without wildcards matches the exact path or any path below it when it names a
 *   directory prefix (e.g. `src` matches `src/a.txt`).
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  let source = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        index += 1;
        if (normalized[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char !== undefined && /[.+^${}()|[\]\\]/.test(char)) {
      source += `\\${char}`;
    } else if (char !== undefined) {
      source += char;
    }
  }
  const hasWildcard = /[*?]/.test(normalized);
  source += hasWildcard ? '$' : '(?:/.*)?$';
  return new RegExp(source);
}

export function matchesGlob(pattern: string, filePath: string): boolean {
  return globToRegExp(pattern).test(filePath.replace(/\\/g, '/'));
}

export const ScopeEvaluationSchema = z
  .object({
    violation: z.boolean(),
    changedFileCount: z.number().int().nonnegative(),
    maxChangedFiles: z.number().int().positive().nullable(),
    forbiddenHits: z.array(z.string()),
    outsideAllowed: z.array(z.string()),
    reasons: z.array(z.string()),
  })
  .strict();

export type ScopeEvaluation = z.infer<typeof ScopeEvaluationSchema>;

export interface ScopePolicyInput {
  readonly changedPaths: readonly string[];
  readonly allowedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly maxChangedFiles: number | null;
}

export function evaluateScopePolicy(input: ScopePolicyInput): ScopeEvaluation {
  const forbiddenHits: string[] = [];
  const outsideAllowed: string[] = [];
  const uniquePaths = [...new Set(input.changedPaths)].sort();

  for (const changedPath of uniquePaths) {
    if (input.forbiddenPaths.some((pattern) => matchesGlob(pattern, changedPath))) {
      forbiddenHits.push(changedPath);
      continue;
    }
    if (
      input.allowedPaths.length > 0 &&
      !input.allowedPaths.some((pattern) => matchesGlob(pattern, changedPath))
    ) {
      outsideAllowed.push(changedPath);
    }
  }

  const reasons: string[] = [];
  if (forbiddenHits.length > 0) {
    reasons.push(`forbidden paths touched: ${forbiddenHits.join(', ')}`);
  }
  if (outsideAllowed.length > 0) {
    reasons.push(`paths outside allowedPaths: ${outsideAllowed.join(', ')}`);
  }
  if (input.maxChangedFiles !== null && uniquePaths.length > input.maxChangedFiles) {
    reasons.push(
      `changed ${String(uniquePaths.length)} files, limit ${String(input.maxChangedFiles)}`,
    );
  }

  return {
    violation: reasons.length > 0,
    changedFileCount: uniquePaths.length,
    maxChangedFiles: input.maxChangedFiles,
    forbiddenHits,
    outsideAllowed,
    reasons,
  };
}
