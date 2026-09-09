# Telemetry

Each trial records token, tool-call, and cost metrics as `MetricValue<T>` records. A metric is never
a bare number: it always carries **quality**, **source**, and an optional **coverageReason** so
reports can fail closed instead of inventing support.

## MetricValue

```ts
interface MetricValue<T> {
  value: T | null;
  quality: 'exact' | 'estimated' | 'unavailable';
  source: string | null;
  coverageReason: string | null;
}
```

| Quality       | Meaning                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `exact`       | Parsed from an authoritative vendor event (for Cursor: `result.usage`). |
| `estimated`   | Derived (summed assistant usage, advisory ceiling, unpriced component). |
| `unavailable` | Missing, unparseable, or excluded by policy. `value` is `null`.         |

Unknown vendor fields are ignored. Unknown _types_ (a usage field that is not a finite number) cause
that stream-json line to be rejected; remaining valid lines still contribute.

## Sources

| Source               | Produced by                                                        |
| -------------------- | ------------------------------------------------------------------ |
| `cursor-stream-json` | `extractCursorTelemetry` over `--output-format stream-json` stdout |
| `pricing-snapshot`   | `computeTelemetryCost` / `estimateAdvisoryExposure`                |
| `custom-command`     | Fake / custom adapters that declare no telemetry                   |
| `null`               | Pre-run placeholders in `ael plan` output                          |

Raw stdout is retained as an artifact even when extraction yields `unavailable`.

## Cursor stream-json extraction

`packages/runtime/src/telemetry/cursorExtractor.ts` Zod-validates each newline-delimited JSON
object (`StreamJsonLineSchema` in `streamJson.ts`).

Usage selection:

1. If any `type: result` event carries a `usage` (or `message.usage`) block, **that** usage is
   authoritative. Per-turn `assistant` usage is ignored. This prevents double-counting: Cursor
   repeats cumulative totals on the final `result` event.
2. Otherwise, sum `usage` across `type: assistant` events (`coverageReason: summed assistant usage`).
3. Otherwise every token metric is `unavailable`.

Tool calls are counted by **unique `call_id`**. Cursor emits `tool_call` twice per invocation
(`subtype: started` then `completed`) sharing a `call_id`. Lines without `call_id` count only when
they are `started` or have no subtype. `stderr.includes('sandbox')` and other agent prose are never
treated as telemetry.

Frozen logs used by unit tests live in `tests/fixtures/cursor-logs/<version>/` and are **hand-authored**
until a redacted real capture exists (see that directory's README).

## Aggregation

`aggregateTelemetryPhases` sums numeric values across phases and records `coverageReason: partial`
when any phase is `unavailable`. Failed phases still contribute the tokens they did emit; they do
not zero out a successful sibling phase.

`summarizeTelemetryCoverage` counts exact / estimated / unavailable slots for
`decisionPolicy.telemetryCoverageMin`. Missing telemetry excludes metrics from cost-per-success
denominators but is reported separately. Gates must not treat `unavailable` as zero.

## Pricing and cost quality

Optional `pricing.yaml` snapshots are fingerprinted before run. Advisory max cost is shown in
`ael plan`; it is **not** a hard spend cap.

`computeTelemetryCost` rules:

| Condition                                                                  | Cost quality  | `value`                                           |
| -------------------------------------------------------------------------- | ------------- | ------------------------------------------------- |
| Model missing from snapshot, or input/output tokens or their rates missing | `unavailable` | `null`                                            |
| Any **measured** (non-null, not `unavailable`) token component has no rate | `estimated`   | priced sum of the components that _do_ have rates |
| Any priced component's own quality is `estimated`                          | `estimated`   | priced sum                                        |
| Every measured component is `exact` and priced                             | `exact`       | full sum                                          |

`subagent` tokens currently have no rate in the snapshot schema, so a non-zero subagent count forces
`estimated`. Subscription SKUs without a public price stay `unavailable`.

`estimateAdvisoryExposure` always returns `estimated` (assumed tokens × rate × invocation count) or
`unavailable` when the snapshot cannot price the model.

## Environment flags

| Variable                      | Effect                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AEL_LIVE_CURSOR=1`           | Enables the **paid** Cursor sandbox probe (`probeCursorSandbox`). Default: skipped, capabilities unverified. Never set this in CI.               |
| `AEL_SKIP_SANDBOX_PROBE=1`    | Adapter and isolation doctors skip the probe even if `AEL_LIVE_CURSOR=1`. Observed capabilities stay unverified. Used by synthetic verification. |
| `AEL_APPROVE_LIVE_RUN=1`      | Same as `ael run --approve-live-run`. Required to execute a Cursor suite; writes `<outputRoot>/live-approval.json`.                              |
| `AEL_ALLOW_UNTESTED_CURSOR=1` | Doctor `ready` stays true when `cursor-agent --version` is outside `TESTED_CURSOR_VERSION_RANGES` (still warns).                                 |
| `AEL_LIVE_TESTS`              | **Dead.** Documented in older CI/CONTRIBUTING copy; live Cursor tests actually gate on `AEL_LIVE_CURSOR`. Do not set.                            |

## CLI surfaces

- `ael doctor --suite <file> [--out <dir>]` prints model, agent version, trial count, timeout,
  advisory cost, fairness warnings, and requested vs observed capabilities. Writes `doctor.json`
  when `--out` is set. `ready` is false when the agent binary is missing.
- `ael plan --json` includes `advisoryCostUsd`, `fairnessWarnings`, and `holdpointB.liveRunAuthorized: false`.
- `ael run --approve-live-run` (or `AEL_APPROVE_LIVE_RUN=1`) is the only way to start a Cursor trial.
- `ael status --json` scans `attempts/*/*/state.json` (latest attempt per trial) and prints counts.

Holdpoint B (paid Cursor pilot) still requires a human review of `ael plan` output before approval.
The harness never treats `--sandbox enabled` as proof of filesystem enforcement.
