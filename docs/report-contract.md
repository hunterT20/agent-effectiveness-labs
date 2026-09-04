# Report contract

`report/report.json` is the **normalized source of truth**. Markdown, CSV and HTML are derived
views. `ael report` must not invoke an agent; it only reads artifacts already on disk.

JSON Schema for a single gate row: `schemas/gateResult.schema.json`. The full report document is
the `ReportSource` type in `@ael/reporter`.

## `ReportSource` fields

| Field           | Type                                        | Meaning                                                                                          |
| --------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `schemaVersion` | `1`                                         | Report contract version                                                                          |
| `experimentId`  | string                                      | Stable id for this experiment root                                                               |
| `suiteName`     | string                                      | From the suite document                                                                          |
| `verdict`       | `PASSED` \| `FAILED` \| `INSUFFICIENT_DATA` | From `deriveVerdict(gates)`                                                                      |
| `gates[]`       | `GateResult[]`                              | Every evaluated gate, with evidence paths                                                        |
| `statistics`    | `ExperimentStatistics`                      | Fixture-cluster summaries                                                                        |
| `generatedAt`   | ISO-8601                                    | Reporter currently stamps `1970-01-01T00:00:00.000Z` so views are byte-identical across machines |

### `GateResult`

| Field           | Meaning                                                                     |
| --------------- | --------------------------------------------------------------------------- |
| `id`            | Stable gate id (see [experiment-methodology.md](experiment-methodology.md)) |
| `status`        | `passed` \| `failed` \| `insufficient_data`                                 |
| `actual`        | Observed number, or `null` when unknown                                     |
| `expected`      | Human-readable threshold                                                    |
| `message`       | One-line description                                                        |
| `evidencePaths` | Files a reviewer can open (at least the experiment root)                    |

### `ExperimentStatistics` (core)

Independent fixture count, trial count, paired sign test, verified-success rates and delta, median
and P90/P95 durations per arm, infrastructure failure rate. `null` means “not computable”, never a
silent zero that looks like “no failures”.

Cluster bootstrap, Holm tables, power warnings and blinded-rubric summaries are produced by core
helpers. Folding them into `report.json` as first-class sections is **Planned**; do not invent
fields the reporter does not serialize yet.

## Derived views

Written next to `report.json` by `ael report`:

| File          | Rules                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `report.md`   | Deterministic Markdown: verdict, summary rates, one bullet per gate                                                              |
| `report.csv`  | Header + summary row + one row per gate. Cells starting with `= + - @` get a leading `'`                                         |
| `report.html` | Self-contained HTML. All agent-influenced strings run through `escapeHtml`. CSP: `default-src 'none'; style-src 'unsafe-inline'` |

There is **no** inline script. HTML is a view, not an app.

## Regeneration

Given the same `ReportSource`, `serializeReportJson` / `renderReportMarkdown` / `renderReportCsv` /
`renderReportHtml` are pure. Re-running `ael report` without changing artifacts must not require a
network or an agent.

Byte-identical JSON depends on `generatedAt` being pinned (currently epoch) and on stable key
order from `JSON.stringify` of already-sorted structures. Do not sprinkle `Date.now()` into the
source object.

## CLI stdout / exit codes

- stdout: the verdict word (`PASSED` / `FAILED` / `INSUFFICIENT_DATA`).
- `--fail-on-verdict`: exit `5` unless the verdict is `PASSED`; otherwise `0`.
- Config problems: exit `2`. I/O: exit `4`.

See [cli.md](cli.md).

## Current limitation (truthful)

In this tree, `reportCommand` calls `evaluateGates` with **placeholder statistics**:

- `trialCount: 0`
- `completedPairs: 0`
- `infrastructureFailureRate: null`
- sign-test p-values `null`

so a real experiment’s `ael report` currently yields `INSUFFICIENT_DATA` even when trials completed.
Aggregating `attempts/**/grade-report.json` (and telemetry) into `computeExperimentStatistics` is
owned by the stats/report fix wave, not by this release-infra change. The reporter package itself
already renders whatever `ReportSource` it is given.

## Safety

- Do not embed protected candidate blobs or unredacted logs in any view.
- Do not compute a composite “AEL score”.
- `unavailable` metrics must print as `unavailable`, not `0`.

## Fairness and telemetry (Planned on the document)

The README promises fairness warnings and telemetry coverage on the report. `ael plan --json`
already emits `fairnessWarnings` and a coverage template. Copying those objects into `report.json`
is **Planned** once aggregation lands. Until then, read them from `trial-plan.json` / plan JSON.
