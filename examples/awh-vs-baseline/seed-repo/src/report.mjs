export function summarize(entries) {
  const total = entries.reduce((sum, entry) => sum + entry.amountCents, 0);
  return { total, count: entries.length };
}
