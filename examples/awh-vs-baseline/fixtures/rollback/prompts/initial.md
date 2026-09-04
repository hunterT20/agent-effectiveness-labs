<!-- ael-fake-mode: success -->

1.3.0 changed monthlyRate to return percentage points per month. That
explodes projectBalance. Restore monthlyRate(annualPercent) to
annualPercent / 100 / 12 so monthlyRate(12) === 0.01, and record 1.3.1 in
docs/CHANGELOG.md. Do not paper over the bug only inside projectBalance.
