export function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.trunc(abs / 100);
  const remainder = String(abs % 100);
  return sign + '$' + dollars + '.' + remainder.padEnd(2, '0');
}
