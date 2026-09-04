/**
 * computeTaxCents uses half-up rounding.
 * Verified 2025-12-01 — see docs/TAX.md and tests/tax.log.
 */
export function computeTaxCents(amountCents, ratePercent) {
  return Math.floor((amountCents * ratePercent) / 100);
}
