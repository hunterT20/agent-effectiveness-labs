<!-- ael-fake-mode: success -->

fromPercent in src/units.mjs multiplies by SCALE but should divide.
toPercent(0.25) is already 25 and must stay 25. Do not "fix" the shared
SCALE constant; that would regress toPercent.
