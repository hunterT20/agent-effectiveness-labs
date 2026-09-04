# Experiment methodology

AEL answers a causal question: **holding the fixture, prompt, commit, agent, model, sandbox,
timeout and grader fixed, does the treatment arm beat the control arm?** If the design or the
evidence cannot support that question, the verdict is `INSUFFICIENT_DATA`, not a guessed score.

## Causal comparison

Within one preregistered comparison (`primaryControlArm` vs `primaryTreatmentArm` in `suite.yaml`):

- The seed repository and pinned `commit` are identical.
- Fixture prompts, graders, timeouts and isolation provider are identical.
- Only **arm materialization** differs (overlays, env, argv, plugins, sandboxed setup).

Anything else (different model, different timeout, different grader) is a different experiment and
must be a different suite or a new sealed plan.

## Primary vs secondary arms

- Exactly one **primary** control/treatment pair is named on the suite.
- Additional treatment arms listed in `arms[]` become **secondary** comparisons.
- When `decisionPolicy.multipleComparisonMethod: holm`, secondary p-values are adjusted with the
  Holm step-down procedure (`applyHolmCorrection`, method version `holm-v1`). `bonferroni` and
  `none` are accepted by the schema; Holm is the implemented correction used by stats helpers.

Do not peek at secondary results and then promote them to primary. The primary pair is sealed in
`preregistration.json`.

## Independent unit: the fixture cluster

The independent inference unit is the **fixture**, not the trial.

- `defaults.repeats` re-runs the same fixture × arm to estimate within-fixture variance.
- `minimumIndependentFixtures` counts distinct `fixtureId`s, not `repeats`.
- Cluster bootstrap (`clusterBootstrapCi`, `cluster-bootstrap-v1`) resamples **whole fixtures**
  with a seeded Mulberry32 PRNG (default 2000 iterations, 95% percentile interval). Repeats are not
  treated as independent tasks.

## Binary success and the paired sign test

For each fixture (and repeat index), Labs pairs control vs treatment `verifiedSuccess` booleans.

- Improvements: treatment true, control false.
- Regressions: treatment false, control true.
- Ties: both true or both false.

`pairedSignTest` reports a one-sided exact sign test (H1: treatment better) and a two-sided
descriptive p-value. Discordant count of zero → both p-values `null` (not zero).

Rates use `numerator / denominator` and are `null` when the denominator is zero — never `NaN`.
Duration summaries use median and nearest-rank P90/P95.

## Decision policy modes

`decisionPolicy.mode`:

| Mode            | Behaviour                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `preregistered` | Evaluates `verified-success-delta` and `paired-improvement-significance` as pass/fail gates            |
| `exploratory`   | Those two gates are **not** evaluated. The report is a low-power exploration, not a confirmatory claim |

Exploratory mode exists so a small suite can still produce a report. It does **not** convert a
missing sample into `PASSED`.

## Gates that exist in `@ael/core` today

Implemented by `evaluateGates` / `deriveVerdict`:

| Gate id                               | Pass condition                                              | Else                |
| ------------------------------------- | ----------------------------------------------------------- | ------------------- |
| `minimum-completed-pairs`             | `completedPairs >= minimumCompletedPairs`                   | `insufficient_data` |
| `minimum-independent-fixtures`        | `independentFixtureCount >= minimumIndependentFixtures`     | `insufficient_data` |
| `maximum-infrastructure-failure-rate` | known rate `<= maximumInfrastructureFailureRate`            | `insufficient_data` |
| `verified-success-delta`              | `delta >= verifiedSuccessDeltaMin` (preregistered only)     | `failed`            |
| `paired-improvement-significance`     | one-sided p `<= pairedImprovementPValueMax` (preregistered) | `failed`            |

Verdict: any `failed` → `FAILED`; else any `insufficient_data` → `INSUFFICIENT_DATA`; else
`PASSED`.

Other `decisionPolicy` fields (`telemetryCoverageMin`, cost/duration/token ratios, safety maxima)
are **schema-valid today** but are not yet wired as gates in `evaluateGates`. Treat them as
**Planned** until a stats-integration change consumes them.

## Power / readiness

`assessPowerReadiness` approximates the fixture count needed for a paired sign test to detect
`verifiedSuccessDeltaMin` at α=0.05, power=0.8. If the planned fixture count is lower, it emits an
`UNDERPOWERED` warning. That warning is informational; it does not by itself flip a gate to
`failed`.

## Human rubric

Blinded packets via `ael grade export` / `ael grade import`. Inter-rater agreement is Cohen's kappa
(`cohen-kappa-v1`) on two raters. Missing raters, incomplete criteria, or kappa below
`--minimum-agreement` (default `0.6`) reject the import.

## No optional stopping

The trial order is sealed before the first invoke. Do not stop early because interim deltas look
good. Resume continues the sealed plan; it does not rewrite membership.

## Verdicts

| Verdict             | Meaning                                        |
| ------------------- | ---------------------------------------------- |
| `PASSED`            | Every evaluated gate passed                    |
| `FAILED`            | At least one evaluated gate failed             |
| `INSUFFICIENT_DATA` | Missing evidence, underpowered design, or both |

Never collapse status, grade dimensions, and evidence quality into a single unverifiable score.
