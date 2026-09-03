# Experiment methodology

## Causal comparison

Within a preregistered comparison, fixture, prompt, commit, agent, model, sandbox, timeout, and
grader are identical. Only arm materialization differs.

## Primary vs secondary arms

- One **primary** control/treatment pair is preregistered in `suite.yaml`
- Secondary treatment comparisons use **Holm correction** when `multipleComparisonMethod: holm`

## Statistics

- Binary success: paired fixture outcomes + one-sided exact sign test (two-sided descriptive)
- Continuous deltas: **cluster bootstrap** CI resampling whole fixtures (seeded, versioned)
- Power/readiness: warns when planned fixtures cannot detect `verifiedSuccessDeltaMin`

## Human rubric

Blinded packets via `ael grade export` / `ael grade import`. Inter-rater agreement uses Cohen's
kappa; adjudication is required when raters disagree per policy.

## Verdicts

| Verdict | Meaning |
| ------- | ------- |
| `PASSED` | All required gates passed |
| `FAILED` | At least one gate failed |
| `INSUFFICIENT_DATA` | Missing evidence or underpowered design |

Never optional-stop after observing favorable interim results.
