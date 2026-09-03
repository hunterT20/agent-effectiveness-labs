# Fixture authoring

Fixtures declare `outcomeMode`: `repository`, `artifact`, or `hybrid`.

## Required pieces

- `fixture.yaml` — schema-valid manifest
- `prompts/` — phase prompts (`session: new` for first phase)
- `grader/check.mjs` — hidden deterministic grader (copied at grade time)
- `reference/solution.patch` and/or `reference/artifacts/`
- `reference/wrong.patch` or wrong artifact directory for mutation cases

## Self-test

```bash
ael fixture self-test path/to/fixture.yaml
```

Valid fixtures must:

1. Fail on seed repository alone
2. Pass reference solution
3. Fail all mutation cases
4. Produce deterministic grades across repeats

## Categories

Tag `category` for reporting (e.g. `bug-fix`, `regression-trap`, `artifact-only`). The
`examples/awh-vs-baseline` suite demonstrates ≥10 plan categories.
