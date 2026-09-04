<!-- ael-fake-mode: success -->

`src/discount.mjs` applies a percentage discount incorrectly.

`applyDiscount(200, 25)` should return `150` (25% off 200), not `175`.
The implementation subtracts the percent as a raw number instead of computing
`price * (1 - percent / 100)`.

Fix `applyDiscount` so that:

- `applyDiscount(200, 25) === 150`
- `applyDiscount(80, 0) === 80`
- `applyDiscount(100, 10) === 90`

Keep the existing range check (`percent` must be between 0 and 100). Do not
change the CLI wrapper.
