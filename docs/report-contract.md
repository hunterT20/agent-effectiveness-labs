# Report contract

`report/report.json` is the normalized source of truth. CSV, Markdown, and HTML are derived views.

## Required sections

- `verdict`: `PASSED` | `FAILED` | `INSUFFICIENT_DATA`
- `gates[]` with `evidencePaths`
- `statistics` including paired sign test, bootstrap CIs, Holm-adjusted secondary comparisons
- `powerReadiness` warnings when applicable
- `blindedRubric` agreement and adjudication summary
- fairness warnings and telemetry coverage

## Regeneration

Reports must regenerate byte-identically from experiment artifacts without re-invoking agents.

## Safety

Agent-provided strings are escaped in HTML. CSV formula-injection prefixes are neutralized.
