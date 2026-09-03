# Telemetry

Each trial records token, tool-call, and cost metrics with **quality** (`exact`, `estimated`,
`unavailable`) and `coverageReason`.

## Coverage gates

`decisionPolicy.telemetryCoverageMin` requires sufficient exact/estimated coverage across trials.
Missing telemetry excludes metrics from cost-per-success denominators but is reported separately.

## Pricing

Optional `pricing.yaml` snapshots are fingerprinted before run. Advisory max cost is shown in
`ael plan`; it is not a hard spend cap.

## Cursor adapter

Structured log extraction is version-gated; raw evidence is retained when parsers cannot extract
fields.
