/**
 * Fault-injection seam for adversarial tests.
 * When protections are disabled, adversarial tests must fail.
 */
let protectionsEnabled = true;

export function setProtectionsEnabled(enabled: boolean): void {
  protectionsEnabled = enabled;
}

export function areProtectionsEnabled(): boolean {
  return protectionsEnabled;
}

export function withProtectionsDisabled<T>(fn: () => T): T {
  const previous = protectionsEnabled;
  protectionsEnabled = false;
  try {
    return fn();
  } finally {
    protectionsEnabled = previous;
  }
}
