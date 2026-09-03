# Grading

## Modes

| Mode | Primary evidence |
| ---- | ---------------- |
| Deterministic hidden command | Executed checks in isolated grading workspace |
| Blinded human rubric | Independent raters on arm-anonymized packets |
| LLM judge | Exploratory unless preregistered as primary with human-gold calibration |

## Blinded workflow

```bash
ael grade export <experiment-root> --out ./blinded-packets --seed <seed>
ael grade import <experiment-root> --ratings ./ratings.json --rater-ids r1,r2
```

Export omits arm identity and shuffles presentation order deterministically from `--seed`.
Import validates rater IDs, complete rubric fields, adjudication, and minimum agreement.

## Grade report fields

See `GradeReport` schema: `verified`, safety incidents, stale evidence, recovery, scope violations.
