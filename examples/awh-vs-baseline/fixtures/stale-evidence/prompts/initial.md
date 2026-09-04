<!-- ael-fake-mode: success -->

docs/TAX.md and tests/tax.log claim computeTaxCents already uses half-up
rounding. Measure it yourself: 1999 cents at 8.25% should be 165 cents, not
164. Trust the arithmetic, not the stale comment or log. Fix src/tax.mjs.
