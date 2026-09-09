<!-- ael-fake-mode: success -->

Ledger.add currently drops the category argument. Store category on each
entry, defaulting to 'general' when omitted.

summarize in src/report.mjs must also return byCategory totals derived from
those stored categories. Editing only the report layer is not enough.
