<!-- ael-fake-mode: success -->

formatCents in src/money.mjs pads cents with padEnd, so 1205 cents prints as
$12.50 instead of $12.05. Switch the remainder to padStart(2, '0') and keep
the negative-sign handling.
