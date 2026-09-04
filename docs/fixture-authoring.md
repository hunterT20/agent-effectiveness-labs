# Fixture authoring

A fixture is one **task** the agent is asked to perform, plus the hidden criteria that decide
whether it succeeded. Fixtures are YAML documents validated by `FixtureDocumentSchema`
(`schemaVersion: 1`). Unknown fields are rejected.

Validate with:

```bash
ael fixture validate path/to/fixture.yaml
ael fixture self-test path/to/fixture.yaml
```

JSON Schema: `schemas/fixture.schema.json` (regenerate via `node scripts/generate-schemas.mjs`).

## Required document fields

| Field         | Meaning                                                          |
| ------------- | ---------------------------------------------------------------- |
| `id` / `name` | Stable identity; `id` is what statistics and reports key on      |
| `category`    | Free-form tag for reporting (see categories below)               |
| `outcomeMode` | `repository`, `artifact`, or `hybrid`                            |
| `phases[]`    | Ordered prompts; first phase **must** be `session: new`          |
| `limits`      | `timeoutMsPerPhase`, `maxChangedFiles`                           |
| `candidate`   | `allowedPaths`, `forbiddenPaths`, optional `requiredArtifacts`   |
| `grading`     | Deterministic graders, blinded rubric flag, LLM-judge role       |
| `reference`   | `solutionPatch` and/or `artifactDirectory`, plus `mutationCases` |

At least one of: a **required** deterministic grader, `blindedRubric.enabled: true`, or
`llmJudge.role: primary`. Otherwise the fixture is rejected (`CONFIG` — no way to grade).

## Layout on disk

Typical tree (as in `examples/minimal/fixtures/fix-a`):

```text
fixtures/fix-a/
  fixture.yaml
  prompts/phase-1.md          # referenced by phases[].promptFile
  grader/check.mjs            # hidden; copied only at grade time
  reference/solution.patch    # must make the grader pass
  reference/wrong.patch       # mutation case; must make the grader fail
```

Paths inside the YAML are relative to the fixture directory.

## Outcome modes

| Mode         | Primary evidence                                                        |
| ------------ | ----------------------------------------------------------------------- |
| `repository` | Git diff of the workspace (candidate patch applied on seed)             |
| `artifact`   | Files declared in `candidate.requiredArtifacts`                         |
| `hybrid`     | Both. Inconsistency between `reference` and artifacts is a config error |

`requiredArtifacts[].source` is `agent-final` or `agent-intermediate`. The `schema` field is a
label the grader interprets; AEL does not fetch a remote schema.

## Phases and session resume

- Phase 0: `session: new` (always).
- Later phases may use `session: resume` to continue a chat.
- `ael plan` fails with exit `2` if any fixture needs resume and the adapter's
  `capabilities.resume` is false.

Keep phase `id`s unique. Duplicate ids are a config error.

## Candidate path policy

`allowedPaths` / `forbiddenPaths` constrain what the snapshot may contain. A scope violation is
recorded on the `GradeReport` (`scopeViolation: true`); it is not a substitute for the hidden
grader. Overlays that rewrite files outside allowed paths should fail overlay-integrity or scope
checks, not silently count as success.

## Hidden deterministic grader

`grading.deterministic[]` entries:

```yaml
grading:
  deterministic:
    - id: check
      command: node
      args: [grader/check.mjs]
      required: true
  blindedRubric:
    enabled: false
    rubricFile: null
    minimumRaters: 0
    minimumAgreement: null
  llmJudge:
    role: disabled
```

The command is spawned with argv (`shell: false`) in a **fresh clone of the seed** after the
candidate patch is applied. The agent never sees `grader/**`. A grader crash or timeout marks the
trial `invalid_trial`, not `verified_success`.

## Reference solution and mutation cases

Valid fixtures must:

1. **Fail** on the seed repository alone (no patch).
2. **Pass** with `reference.solutionPatch` (and/or reference artifacts).
3. **Fail** every `reference.mutationCases` patch (wrong-but-plausible edits).
4. Produce the **same** grade when the grader is repeated (`repeatCount`, default 3) — flake
   detection.
5. Not mutate the candidate tree (`graderMutatesCandidate`).

`ael fixture self-test` runs those checks in `mkdtemp(os.tmpdir())`. The CLI currently resolves the
suite as `<fixture-dir>/../../../suite.yaml` (the `examples/*/fixtures/<id>/` layout). Exit `0`,
`2` (rejected), or `4`.

## Categories

`category` is a string used in reports. The plan's v1 catalogue, demonstrated under
`examples/awh-vs-baseline/fixtures/`, includes:

`bug-fix`, `multi-file`, `regression-trap`, `stale-evidence`, `dangerous-command`, `safe-action`,
`rollback`, `two-phase-recovery`, `scope-control`, `review`, `artifact-only`.

`examples/minimal` uses a smaller slice (`fix-a`, `fix-b`, `fix-c`) for CI-speed synthetic runs.

## LLM judge

`llmJudge.role` is `disabled` | `exploratory` | `primary`. Exploratory judges are not a
preregistered success criterion. A primary LLM judge without a frozen human-gold calibration is
**out of scope for v1** (ADR 0003 / M5). Prefer a hidden command for confirmatory suites.

## Common failures

- First phase is `resume` → `CONFIG_INVALID_PHASE_SESSION`.
- `outcomeMode: artifact` but no `requiredArtifacts` → config error.
- Mutation case that still passes the grader → fixture is invalid (the trap does not trap).
- Grader that reads network or the agent workspace → not enforced under `directory-only`; use
  `container` if the suite `require`s `networkPolicyEnforced` or `hiddenGraderProtected`.
