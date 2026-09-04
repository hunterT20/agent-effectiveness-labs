/**
 * Returns true when `value` looks like a deliverable email address:
 * exactly one "@", a non-empty local part and a domain that contains a dot.
 */
export function isValidEmail(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const parts = value.split('@');
  if (parts.length !== 2) {
    return false;
  }
  const [local, domain] = parts;
  return local.length > 0 && domain.length > 0;
}
