# CLI reference (`ael`)

`ael` is the Commander-based entrypoint in `@ael/cli` (`packages/cli/src/index.ts`). This page
documents the commands, the exit-code contract, the stdout/stderr contract and the environment
variables that the current code base reads. Anything marked **Planned** is not implemented yet and
must not be relied upon.

## Installation

```bash
npm install -g @ael/cli      # or: pnpm add -g @ael/cli
ael --version
```

From a checkout: `pnpm install && pnpm build`, then `node packages/cli/dist/index.js ...`.
Requires Node.js `>=24` (`engines.node`, enforced by `engine-strict=true` in `.npmrc` for pnpm).

## Exit-code contract

| Code | Constant            | Meaning                                                                  |
| ---- | ------------------- | ------------------------------------------------------------------------ |
| `0`  | `EXIT_OK`           | Command completed; for `report --fail-on-verdict`, verdict was `PASSED`  |
| `2`  | `EXIT_CONFIG`       | Suite / fixture / arm / ratings invalid, or a plan-time precondition hit |
| `3`  | `EXIT_CAPABILITY`   | Requested capability not observed (`doctor`), or live run not authorized |
| `4`  | `EXIT_RUNTIME`      | Unexpected runtime failure (I/O, git, adapter, grader crash)             |
| `5`  | `EXIT_VERDICT_FAIL` | `report --fail-on-verdict` and verdict was not `PASSED`                  |

Defined in `packages/cli/src/exitCodes.ts`. Exit codes are set via `process.exitCode`, so buffered
output is flushed before the process ends. Commander's own usage errors (unknown command, missing
required option) exit with Commander's default `1` — treat `1` as "invocation error".

## stdout / stderr contract

- **stdout** carries the result: `suite valid`, `planned 6 trials`, the JSON document for
  `plan --json`, `completed N trials`, the verdict word for `report`, `exported N blinded packets`.
  When `--json` is given, stdout contains **only** the JSON document (single object, pretty-printed,
  trailing newline) so it can be piped to `jq`.
- **stderr** carries diagnostics: doctor messages, `fairness-warning:` lines, Holdpoint B notices,
  validation issues (one per line) and error messages. Nothing on stderr is machine-parsed.
- Secrets are redacted before anything is written to trial logs (`ProcessSupervisor` redaction
  stream); the CLI itself never echoes environment values.

## Commands

### `ael suite validate <suite.yaml>`

Loads the suite manifest (`loadSuiteManifest`), resolves relative paths against the manifest
directory and rejects unknown fields (`AEL_CONFIG_UNKNOWN_FIELD`), wrong `schemaVersion`
(`AEL_CONFIG_INVALID_SCHEMA_VERSION`), non-finite numbers and invalid thresholds. All issues are
reported, not just the first. Exit `0` or `2`.

### `ael fixture validate <fixture.yaml>`

Parses one fixture document (`parseFixtureDocument`): phase ordering (`new` first, `resume` only
after a phase), consistency of `outcomeMode` with `reference` / `candidate.requiredArtifacts`, at
least one required grader or blinded rubric. Exit `0` or `2`.

### `ael fixture self-test <fixture.yaml>`

Qualifies a fixture against the suite in the grandparent `examples` directory
(`<fixture-dir>/../../../suite.yaml`): the seed repository must **fail** the grader, the reference
solution must **pass**, every `reference.mutationCases` patch must **fail**, and repeated grading
must be stable. Work happens in `mkdtemp(os.tmpdir())`. Exit `0`, `2` (fixture rejected, reasons on
stderr) or `4`.

### `ael arm validate <arm.yaml>`

Validates an arm document: `actions[]` is a discriminated union of `home-overlay`,
`workspace-overlay`, `environment`, `agent-argument`, `plugin-directory`,
`sandboxed-setup-command`. Exit `0` or `2`.

### `ael doctor --suite <suite.yaml>`

Readiness check **without** invoking a trial:

1. Adapter doctor (`fake-agent`, `cursor`, or `custom-command`): version, tested-range check for
   Cursor, optional sandbox probe.
2. Isolation doctor for `suite.isolation.provider`, comparing `suite.isolation.require.*` against
   **observed** capabilities.

stdout: `agent=<adapter> model=<model> isolation=<provider>` and `agent-version=<v>` when known.
stderr: every doctor message. Exit `0` when ready, `3` when a required capability was not
observed, `2` on config errors. For `adapter: cursor` a Holdpoint B reminder is always printed.

### `ael plan --suite <suite.yaml> --output <root> [--json]`

Builds the deterministic trial plan (`buildTrialPlan`) from fixtures × arms × `defaults.repeats`
with the suite `randomSeed`, seals the preregistration and writes:

- `<root>/trial-plan.json`
- `<root>/preregistration.json`

Fails early (exit `2`) if any fixture phase uses `session: resume` and the adapter lacks
`capabilities.resume`. Human output lists `planned N trials`, `agent-invocations`, `timeout-ms`,
`model`, `advisory-max-cost-usd` (from `pricing.yaml` if present, otherwise `unavailable`).
`--json` emits the full plan report (fingerprints, counts, isolation, telemetry coverage template,
`fairnessWarnings`, `holdpointB.liveRunAuthorized: false`).

### `ael run --suite <suite.yaml> --output <root> [--fake-agent <path>]`

Runs the experiment: `plan` (into the same `<root>`), then `runExperiment` under an exclusive
`lock.json`, executing trials in sealed order with `defaults.concurrency` (default `1`).

- `adapter: fake-agent` → `--fake-agent` must point at a Node script (the repository ships
  `tests/fake-agent/fake-agent.mjs`; it is **not** inside the npm package). Without the flag the
  CLI falls back to a path relative to the checkout that does not exist in an npm install.
- `adapter: cursor` → refused with exit `3` (`cursor live runs are not authorized without
Holdpoint B approval`). See `AEL_APPROVE_LIVE_RUN` below.
- any other `adapter` string → `custom-command` adapter spawning that program.

Artifacts under `<root>`: `events.ndjson` (append-only), `attempts/<trialId>/<attemptId>/`
(`state.json`, `telemetry*.json`, `candidate-snapshot.json`, `grade-report.json`, `logs/`,
`artifacts/`), `trials/<trialId>/<attemptId>/workspace`. Ctrl+C stops scheduling, kills the running
trial and leaves a resumable state (`experiment interrupted; resume to continue` on stderr).
stdout: `completed N trials`. Exit `0`, `2`, `3` or `4`.

### `ael resume <experiment-root> --suite <suite.yaml> [--fake-agent <path>]`

Same code path as `run` against an existing root. Attempts whose `state.json` is `completed` are
skipped; stored fingerprints (suite, agent, isolation, pricing) are compared with the current ones
and a mismatch is recorded as `CONFIG_DRIFT` for that trial instead of silently re-running.
Infrastructure failures are retried up to the runner's retry limit; agent failures are **not**
auto-retried.

### `ael status <experiment-root>`

Reads `trial-plan.json` and prints `trials=N`. Exit `0` or `4`. Per-trial progress output is
**Planned**.

### `ael report <experiment-root> --suite <suite.yaml> [--fail-on-verdict]`

Evaluates the decision gates and writes `report/report.json`, `report.md`, `report.csv`,
`report.html` (see [report-contract.md](report-contract.md)). Prints the verdict word on stdout.
With `--fail-on-verdict` the exit code is `5` unless the verdict is `PASSED`.

> **Current limitation.** In this build the `report` command derives gates from the suite policy
> with placeholder statistics (zero completed pairs), so the verdict for a real run is
> `INSUFFICIENT_DATA` until the per-trial evidence aggregation lands. Aggregating
> `grade-report.json` / `telemetry.json` into `statistics` is **Planned** for the current fix wave.

### `ael grade export <experiment-root> --out <dir> [--seed <seed>]`

Builds blinded rating packets from graded trials (`loadTrialGradeRecords`): arm identity removed,
presentation order shuffled deterministically from `--seed` (default `ael-blinded-export`). Uses the
built-in rubric `correctness` / `safety` / `recovery`. Exit `2` when no graded trials exist.

### `ael grade import <experiment-root> --ratings <ratings.json> --rater-ids <a,b> [--minimum-agreement <rate>]`

Validates a ratings file (`{ "ratings": BlindedRating[] }`): every expected rater present, all
rubric criteria filled, adjudication rules, Cohen's kappa ≥ `--minimum-agreement` (default `0.6`).
Writes the import document into the experiment root. Exit `0`, `2` (rejected, reasons on stderr)
or `4`.

## Environment variables

| Variable                 | Status                    | Read by                                         | Effect                                                                                                                                                                                                                            |
| ------------------------ | ------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AEL_SKIP_SANDBOX_PROBE` | Implemented               | `@ael/cli`, Cursor adapter, `agent-cli-sandbox` | `=1` skips the live `cursor-agent` sandbox probe in `doctor`; the provider then reports **all** capabilities as unenforced and `supported: true` only when the suite requires none. CI/test convenience — never use for live runs |
| `AEL_RUN_KEY_FILE`       | Implemented (runtime API) | `@ael/runtime` `createRunKeySourceFromEnv()`    | Path to a file containing a 32-byte hex key used by `ProtectedBlobStore` to encrypt candidate patches/untracked archives. Wiring into `ael run` (so CLI runs produce protected blobs) is **Planned**                              |
| `AEL_LIVE_CURSOR`        | Implemented (tests only)  | `tests/live/**`                                 | `=1` enables the live Cursor smoke tests. CI never sets it; the `live` vitest project is a no-op otherwise                                                                                                                        |
| `AEL_APPROVE_LIVE_RUN`   | **Planned**               | `ael run` with `adapter: cursor`                | Explicit, per-invocation approval token for live/paid runs after Holdpoint B review. Until it exists, `ael run` always refuses the Cursor adapter with exit `3`                                                                   |
| `AEL_FAKE_MODE`          | Implemented               | `tests/fake-agent/fake-agent.mjs`               | Selects fake-agent behaviour (`success`, `incorrect`, `timeout`, `claims-done`, ...). Test-only                                                                                                                                   |

`AEL_LIVE_TESTS` appears in older docs but is **not** read by any code; use `AEL_LIVE_CURSOR`.

## Typical session

```bash
ael suite validate examples/minimal/suite.yaml
ael doctor --suite examples/minimal/suite.yaml
ael plan   --suite examples/minimal/suite.yaml --output ./out --json | jq .counts
ael run    --suite examples/minimal/suite.yaml --output ./out --fake-agent tests/fake-agent/fake-agent.mjs
ael report ./out --suite examples/minimal/suite.yaml --fail-on-verdict; echo "exit=$?"
```
