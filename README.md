# Agent Effectiveness Labs

Agent Effectiveness Labs (`ael`) is a provider-neutral CLI for **causal** comparisons of coding-agent
augmentations (skills, harnesses, rules, memory layers) under controlled fixtures, hidden grading,
and preregistered decision policies.

## Positioning

| Tool                                                                  | Focus                           | AEL difference                                                                                                                |
| --------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [skill-eval-harness](https://github.com/hunterT20/skill-eval-harness) | Skill regression checks in-repo | AEL runs **paired arm experiments** with sealed plans, cluster statistics, and `PASSED`/`FAILED`/`INSUFFICIENT_DATA` verdicts |
| [Inspect AI](https://github.com/UKGovernmentBEIS/inspect_ai)          | Model eval tasks & scorers      | AEL targets **repository/agent workspace trials** with isolation, telemetry, and supply-chain gates for enterprise release    |
| [Harbor](https://github.com/harborhq/harbor)                          | Agent benchmark orchestration   | AEL emphasizes **causal fairness**, hidden graders, blinded human rubrics, and offline reproducible reports                   |

## Quick start

```bash
pnpm install
pnpm build
node packages/cli/dist/index.js suite validate examples/minimal/suite.yaml
node packages/cli/dist/index.js plan --suite examples/minimal/suite.yaml --output /tmp/ael-plan --json
```

Synthetic runs use the bundled fake agent. **Live cursor-agent runs require explicit Holdpoint B approval**
after reviewing `ael plan` output (model, trials, timeout, advisory cost).

## Paid-run approval workflow

1. `ael doctor --suite <suite.yaml>` — capability and isolation check
2. `ael plan --suite <suite.yaml> --output <root> --json` — sealed trial plan and advisory exposure
3. Human review of fairness warnings, telemetry coverage, and cost ceiling
4. Explicit approval before `ael run` with a live adapter

## INSUFFICIENT_DATA examples

Verdict is `INSUFFICIENT_DATA` when required evidence is missing but no gate failed:

- fewer completed fixture pairs than `decisionPolicy.minimumCompletedPairs`
- infrastructure failure rate above `maximumInfrastructureFailureRate`
- telemetry coverage below `telemetryCoverageMin`
- incomplete blinded human ratings or inter-rater agreement below fixture policy
- power/readiness warning: planned fixtures cannot detect preregistered `verifiedSuccessDeltaMin`

## Documentation

- [Architecture](docs/architecture.md)
- [Threat model](docs/threat-model.md)
- [Experiment methodology](docs/experiment-methodology.md)
- [Fixture authoring](docs/fixture-authoring.md)
- [Arm authoring](docs/arm-authoring.md)
- [Adapter authoring](docs/adapter-authoring.md)
- [Grading](docs/grading.md)
- [Telemetry](docs/telemetry.md)
- [Report contract](docs/report-contract.md)

## Release

- Semver via [Changesets](.changeset/README.md)
- Offline gate: `node scripts/verify-release.mjs`
- npm provenance: publish with `npm publish --provenance` from GitHub Actions (see release workflow)

## License

MIT — see [LICENSE](LICENSE).
