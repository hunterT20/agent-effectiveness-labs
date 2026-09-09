# Agent Effectiveness Labs

Agent Effectiveness Labs (`ael`) is a provider-neutral CLI for **causal** comparisons of coding-agent
augmentations (skills, harnesses, rules, memory layers) under controlled fixtures, hidden grading,
and preregistered decision policies.

It answers one question honestly: _does augmentation X make agent Y better on task set Z, or is
the evidence insufficient to say?_ Verdicts are `PASSED`, `FAILED`, or `INSUFFICIENT_DATA` — never a
single composite score, and never a claim the harness cannot back with evidence on disk.

## Positioning

| Tool                                                                  | Focus                           | AEL difference                                                                                                                |
| --------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [skill-eval-harness](https://github.com/hunterT20/skill-eval-harness) | Skill regression checks in-repo | AEL runs **paired arm experiments** with sealed plans, cluster statistics, and `PASSED`/`FAILED`/`INSUFFICIENT_DATA` verdicts |
| [Inspect AI](https://github.com/UKGovernmentBEIS/inspect_ai)          | Model eval tasks & scorers      | AEL targets **repository/agent workspace trials** with isolation, telemetry, and supply-chain gates for enterprise release    |
| [Harbor](https://github.com/harborhq/harbor)                          | Agent benchmark orchestration   | AEL emphasizes **causal fairness**, hidden graders, blinded human rubrics, and offline reproducible reports                   |

What makes AEL different in one line: **fail-closed verdicts + fixture-cluster statistics +
adversarial trust model + safety/recovery metrics**, with every gate linked to evidence paths.

## Quick start

```bash
pnpm install
pnpm build
node examples/minimal/scripts/init-seed-repo.mjs          # creates the pinned seed git repo
node packages/cli/dist/index.js suite validate examples/minimal/suite.yaml
node packages/cli/dist/index.js plan --suite examples/minimal/suite.yaml --output /tmp/ael-plan --json
node packages/cli/dist/index.js run  --suite examples/minimal/suite.yaml --output /tmp/ael-run \
  --fake-agent tests/fake-agent/fake-agent.mjs
node packages/cli/dist/index.js report /tmp/ael-run --suite examples/minimal/suite.yaml
```

Synthetic runs use the bundled fake agent (`tests/fake-agent/fake-agent.mjs`, not part of the npm
package — pass `--fake-agent` explicitly when installed from npm). **Live `cursor-agent` runs
require explicit Holdpoint B approval** after reviewing `ael plan` output (model, trials, timeout,
advisory cost). `ael run` refuses `adapter: cursor` today; see [docs/cli.md](docs/cli.md).

Full command reference, exit codes and environment variables: [docs/cli.md](docs/cli.md).

## Boundary of universal support

AEL is provider-neutral, but "neutral" does not mean "everything is guaranteed everywhere". The
harness only claims what it can **observe**; everything else is recorded as unenforced and, when a
suite `require`s it, blocks a conclusive verdict.

### What AEL guarantees regardless of agent or isolation provider

- Deterministic, sealed trial plan (`trial-plan.json`, `preregistration.json`) from the suite's
  `randomSeed`; byte-identical for the same inputs.
- Fresh seed workspace per trial from a pinned commit; arm materialization recorded with content
  hashes (`arm-materialization.json`).
- Candidate snapshot after the agent process tree exits, with overlay-integrity check.
- Hidden graders are copied into a **separate** grading workspace only after the agent exits; the
  agent never sees `grader/**`.
- Bounded, redacted process logs; append-only `events.ndjson`; checkpointed `state.json` per
  attempt; resume refuses on configuration drift.
- Verdict derivation from preregistered gates; `INSUFFICIENT_DATA` when evidence is missing.

### What depends on the isolation provider

| Capability                   | `directory-only`     | `agent-cli-sandbox` (Cursor)             | `container` (Docker)                        |
| ---------------------------- | -------------------- | ---------------------------------------- | ------------------------------------------- |
| `filesystemEnforced`         | never (synthetic)    | observed by probe (read HOME, write out) | observed by in-container probe              |
| `networkPolicyEnforced`      | never                | observed by probe                        | `--network none` + probe                    |
| `processTreeEnforced`        | never                | never                                    | yes (container lifetime)                    |
| `hiddenGraderProtected`      | never                | never                                    | grader root not mounted                     |
| `externalArtifactsProtected` | never                | never                                    | artifact root not mounted                   |
| Intended use                 | fake-agent CI, demos | live Cursor pilots behind Holdpoint B    | reference sandbox for trust-hardened suites |

`ael doctor` prints the **observed** capabilities and fails with exit code `3` when the suite
`require`s one that was not observed. Flags such as `--sandbox enabled` are never trusted by
themselves.

### What depends on the agent CLI

- **Telemetry** (tokens, tool calls, cost): only as good as the agent's structured output. The
  Cursor adapter parses `stream-json` for tested version ranges; anything else degrades to
  `unavailable` with a `coverageReason`, and cost gates then report `INSUFFICIENT_DATA`.
- **Session resume** (multi-phase fixtures): requires `capabilities.resume`; `ael plan` fails early
  (exit `2`) otherwise.
- **Sandbox behaviour of the agent itself**: probed, recorded, never assumed.
- **Platform**: Linux and macOS are required CI targets; Windows is best-effort (ADR 0003).

## Paid-run approval workflow

1. `ael doctor --suite <suite.yaml>` — capability and isolation check
2. `ael plan --suite <suite.yaml> --output <root> --json` — sealed trial plan and advisory exposure
3. Human review of fairness warnings, telemetry coverage, and cost ceiling
4. Explicit approval before `ael run` with a live adapter

Approval must document model, trial count, timeout, telemetry capability and the advisory cost
ceiling (see `AGENTS.md`). The advisory cost is an estimate, not a hard spend cap.

## INSUFFICIENT_DATA examples

Verdict is `INSUFFICIENT_DATA` when required evidence is missing but no gate has actually failed.
Gates implemented in `@ael/core` today that produce it:

- `minimum-completed-pairs`: fewer completed fixture pairs than
  `decisionPolicy.minimumCompletedPairs`
- `minimum-independent-fixtures`: fewer fixtures than `minimumIndependentFixtures`
- `maximum-infrastructure-failure-rate`: infrastructure failure rate unknown or above
  `maximumInfrastructureFailureRate`

Other conditions that resolve to `INSUFFICIENT_DATA` rather than a pass:

- required isolation capability not observed by `ael doctor`
- telemetry quality `unavailable` for metrics a cost/token gate needs
- blinded rubric import rejected (missing raters, incomplete criteria, agreement below policy)
- power/readiness warning: planned fixtures cannot detect `verifiedSuccessDeltaMin`

In `preregistered` mode, `verified-success-delta` and `paired-improvement-significance` can also
**fail** (→ `FAILED`); in `exploratory` mode they are not evaluated and the report is labelled low
power.

## Documentation

- [CLI reference](docs/cli.md) — commands, exit codes, stdout/stderr contract, env vars
- [Architecture](docs/architecture.md)
- [Threat model](docs/threat-model.md)
- [Experiment methodology](docs/experiment-methodology.md)
- [Fixture authoring](docs/fixture-authoring.md)
- [Arm authoring](docs/arm-authoring.md)
- [Adapter authoring](docs/adapter-authoring.md)
- [Grading](docs/grading.md)
- [Telemetry](docs/telemetry.md)
- [Report contract](docs/report-contract.md)
- [Releasing](docs/releasing.md)
- [ADRs](docs/adr/)

## Release

- Semver via [Changesets](.changeset/README.md); the four packages share one version.
- Offline install gate: `node scripts/verify-release.mjs` (packs, installs into a temp project,
  runs the CLI with all network primitives disabled).
- Performance smoke: `node scripts/verify-synthetic.mjs` (30 synthetic trials in < 5 min).
- Publishing happens only from the tag-triggered
  [release workflow](.github/workflows/release.yml) with npm provenance and a CycloneDX SBOM
  attached to the GitHub release. Procedure: [docs/releasing.md](docs/releasing.md).

## Security

See [SECURITY.md](SECURITY.md) for responsible disclosure. Dependencies are audited weekly by
Dependabot (npm + GitHub Actions) and on every CI run (advisory, non-blocking); commits are scanned
with gitleaks.

## License

MIT — see [LICENSE](LICENSE).
