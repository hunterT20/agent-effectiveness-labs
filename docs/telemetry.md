# Telemetry provenance

Agent Effectiveness Labs records resource usage with explicit provenance. Every metric is a `MetricValue` with:

- `value`: the numeric value or `null`
- `quality`: `exact`, `estimated`, or `unavailable`
- `source`: adapter or extractor identifier
- `coverageReason`: why a value is missing or estimated

## Cursor stream-json extraction

The Cursor adapter invokes `cursor-agent` with `--output-format stream-json`. Extractors aggregate:

- input/output/cached/reasoning/subagent tokens from `usage` objects on assistant/result events
- tool calls from `tool_call` / `tool_use` events and `tool_calls` arrays

Unknown or malformed lines are skipped. If no usable events remain, metrics are `unavailable` (never guessed).

Failed valid trials still persist `telemetry.json` with observed resource usage from completed phases.

## Pricing snapshots

Suite `pricing.yaml` is sealed into the experiment fingerprint before run. Cost is computed only when:

1. a pricing entry exists for the configured model, and
2. required token components are `exact`, and
3. required rate components are present in the snapshot.

Subscription CLIs with no attributable per-token price report cost as `unavailable`.

## Holdpoint B

`ael doctor` and `ael plan --json` report advisory token/cost exposure, model, trial count, timeout, and fairness warnings. Live `cursor-agent` runs require explicit human approval after reviewing plan output.
