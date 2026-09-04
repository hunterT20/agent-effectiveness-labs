# Architecture

Agent Effectiveness Labs (`ael`) is a **local, provider-neutral** harness. It compares coding-agent
augmentations under sealed trial plans, hidden graders, and preregistered gates. It does not ship a
dashboard, remote runner, or marketplace (see [ADR 0003](adr/0003-platform-scope-v1.md)).

## Packages

```text
Suite YAML + fixtures + arms + optional pricing.yaml
        │
        ▼
   @ael/core     contracts, Zod schemas, RFC 8785 fingerprints,
                 scheduler, statistics, decision gates
        │
        ▼
  @ael/runtime   isolation providers, adapters, seed workspaces,
                 arm materialization, trial/experiment runners,
                 hidden grading, telemetry, encrypted artifacts
        │
        ▼
 @ael/reporter   JSON source of truth + Markdown / CSV / HTML views
        │
        ▼
    @ael/cli     Commander entrypoint (`ael`)
```

| Package  | npm name        | Responsibility                                                                  |
| -------- | --------------- | ------------------------------------------------------------------------------- |
| core     | `@ael/core`     | Parse/validate config; identity; plan; stats; `evaluateGates` / `deriveVerdict` |
| runtime  | `@ael/runtime`  | Execute one trial and one experiment; never invent a score                      |
| reporter | `@ael/reporter` | Deterministic views from a `ReportSource`; no agent invocation                  |
| cli      | `@ael/cli`      | Human/CI interface; maps domain errors to exit codes `0/2/3/4/5`                |

All four packages are a **fixed** Changesets group: they always share one version. Node.js `>=24`.

## Trial lifecycle

1. **Validate** — `loadSuiteManifest` / `parseFixtureDocument` / `parseArmDocument` reject unknown
   fields, wrong `schemaVersion`, non-finite numbers and empty arm lists. Every Zod issue is
   reported, not just the first.
2. **Doctor** — adapter `doctor` plus isolation `doctor`. Capabilities are **observed**, never
   inferred from flags such as `--sandbox enabled`.
3. **Plan** — `buildTrialPlan` draws a deterministic permutation from `defaults.randomSeed`
   (Mulberry32, versioned). Writes `trial-plan.json` and `preregistration.json`. Fails early if a
   fixture phase uses `session: resume` and the adapter lacks `capabilities.resume`.
4. **Lock** — `ExperimentLock.acquire` uses `open(..., 'wx')` (O_EXCL). Stale locks are renamed,
   not overwritten in place.
5. **Per trial** — clone seed at the pinned commit → materialize arm → invoke adapter → wait for
   the process tree → snapshot candidate → reconstruct into a **fresh** grading workspace → copy
   `grader/**` (never present in the agent workspace) → run hidden grader → checkpoint
   `state.json` + append `events.ndjson`.
6. **Report** — `evaluateGates` + `deriveVerdict` → `report/report.json` and derived views.

## Evidence layout

Under the experiment root passed to `ael run --output`:

| Path                                        | Role                                           |
| ------------------------------------------- | ---------------------------------------------- |
| `lock.json`                                 | Exclusive experiment lock                      |
| `trial-plan.json` / `preregistration.json`  | Sealed schedule and policy snapshot            |
| `events.ndjson`                             | Append-only event log                          |
| `attempts/<trialId>/<attemptId>/state.json` | Checkpointed trial state machine               |
| `attempts/.../logs/`                        | Bounded, redacted stdout/stderr                |
| `attempts/.../grade-report.json`            | Hidden-grader result (`GradeReport`)           |
| `attempts/.../candidate-snapshot.json`      | Content-addressed candidate (patch + manifest) |
| `trials/<trialId>/<attemptId>/workspace`    | Live agent workspace (not a source of truth)   |
| `report/report.{json,md,csv,html}`          | Written by `ael report`, not by the runner     |

Cleanup **never** deletes `attempts/`. Resume skips `completed` attempts and records `CONFIG_DRIFT`
when stored fingerprints (suite, agent, isolation, pricing) disagree with the current inputs.

## Trust boundary

The agent process only sees the seed workspace plus the arm overlay. Hidden graders, the experiment
artifact root, and (under the `container` provider) the real HOME directory are outside that
namespace. Candidate blobs required for reconstruction can be encrypted by `ProtectedBlobStore`
when a run key is supplied (`AEL_RUN_KEY_FILE`); wiring that into `ael run` is **Planned**.

Path containment uses `path.relative` (`isInside` in `@ael/core`), not string prefixes, so Windows
and POSIX agree.

## Statistical unit

The independent inference unit is the **fixture cluster** (all repeats of one fixture). Repeats
estimate within-fixture variance; they do not inflate the independent-task count used by
`minimum-independent-fixtures`. See [experiment-methodology.md](experiment-methodology.md).

## Verdict flow

1. Collect per-trial metrics and `GradeReport` documents.
2. Compute fixture-cluster statistics (paired sign test, optional cluster bootstrap, Holm).
3. Evaluate preregistered gates (`evaluateGates` in `@ael/core`).
4. Emit `PASSED`, `FAILED`, or `INSUFFICIENT_DATA`. Never a composite score.

> **Current limitation.** `ael report` currently feeds placeholder statistics (zero completed
> pairs) into `evaluateGates`, so a real run reports `INSUFFICIENT_DATA` until another change
> aggregates `grade-report.json` / `telemetry.json`. The gate functions themselves are implemented.

## Isolation providers

| Provider            | Class                              | Intended use                   |
| ------------------- | ---------------------------------- | ------------------------------ |
| `directory-only`    | `DirectoryOnlyIsolationProvider`   | Fake-agent CI and demos        |
| `agent-cli-sandbox` | `AgentCliSandboxIsolationProvider` | Live Cursor behind Holdpoint B |
| `container`         | `ContainerIsolationProvider`       | Docker reference sandbox       |

See [README](../README.md#boundary-of-universal-support) for the observed-capability matrix.

## What this architecture explicitly is not

- Not a hosted eval service. All execution is local `child_process.spawn` with `shell: false`.
- Not a skill-regression linter (that is `skill-eval-harness`).
- Not a model-task scorer (that is Inspect AI).
- Not an orchestration marketplace (that is Harbor).
