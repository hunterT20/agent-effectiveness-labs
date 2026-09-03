# Architecture

Agent Effectiveness Labs separates **configuration**, **runtime execution**, **grading**, and
**reporting** into packages:

```text
Suite YAML + fixtures
        │
        ▼
   @ael/core  — schemas, scheduler, statistics, gates
        │
        ▼
  @ael/runtime — isolation, adapters, trial runner, grading
        │
        ▼
 @ael/reporter — JSON/CSV/Markdown/HTML views
        │
        ▼
    @ael/cli — `ael` commands
```

## Trust boundary

The agent runs in an isolated workspace. Hidden graders and external experiment artifacts are
materialized only after the agent process tree exits. Candidate state is reconstructed from
content-addressed snapshots for grading.

## Statistical unit

The independent inference unit is the **fixture cluster** (all repeats of a fixture). Repeats
estimate within-fixture variance; they do not inflate independent task counts.

## Verdict flow

1. Collect trial metrics and grade reports
2. Compute fixture-cluster statistics (paired sign test, bootstrap CIs, Holm correction)
3. Evaluate preregistered gates
4. Emit `PASSED`, `FAILED`, or `INSUFFICIENT_DATA`
