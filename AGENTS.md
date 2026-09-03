# Agent Effectiveness Labs — Agent Instructions

This repository implements **Agent Effectiveness Labs** (`ael`), a standalone benchmark harness for
measuring coding-agent effectiveness under controlled, auditable conditions.

## Mandatory safety and trust rules

All contributors and automated agents working in this repository must follow these rules without
exception.

### Live and paid trials

- **Do not** run live or paid agent trials without explicit human approval.
- Approval must document the exact model, trial count, timeout, telemetry capability, and advisory
  cost/token ceiling.
- CI and default test runs must keep live tests disabled (`AEL_LIVE_TESTS` unset or `false`).

### Independent grading

- Agent self-reports, CLI exit codes, and agent-authored green tests are **not** proof of success.
- Graders run independently after agent exit against hidden or isolated criteria.
- Never collapse status, grade dimensions, or evidence quality into a single unverifiable score.

### Sandbox and process execution

- Execute external programs with `child_process.spawn` (or equivalent) using **argv arrays** and
  **`shell: false`**.
- Never build shell command strings for subprocess invocation.
- Respect workspace isolation, setup sandboxes, and bounded resource limits defined by the runtime.

### External artifacts

- Parse external JSON/YAML as `unknown` and reject unknown fields.
- Canonicalize and fingerprint suite, fixture, arm, adapter, pricing, and run-plan inputs before
  trusting them.
- Redact secrets from logs, commands, environment, and report views before persistence.
- Candidate blobs required for reconstruction must be encrypted before persistence and never
  rendered in public views.

### Configuration and evidence

- Fail closed when required evidence is missing; report `INSUFFICIENT_DATA` instead of inventing
  support.
- Preserve append-only, auditable evidence with atomic checkpoints.
- Do not silently downgrade trust or claim unsupported capabilities.

## Development workflow

- Use Node.js `>=24` and pnpm `9.15.0` (see root `packageManager` field).
- Follow TDD: write a focused failing test, implement the minimum change, verify green.
- Run `pnpm verify` before considering work complete (`format` + `lint` + `typecheck` + `build` +
  `test`).

## GitHub pull request workflow

All changes merge to `main` through reviewed pull requests (see
[ADR 0002](docs/adr/0002-github-pr-process.md)):

1. Branch from `main` using `feature/<description>`.
2. Run `pnpm verify` locally.
3. Push the branch and open a PR against `main`.
4. CI must pass on **ubuntu-latest** and **macos-latest** before merge.
5. Do not force-push to `main`.
6. Document live or paid trial approval in the PR when applicable.

## Package layout

| Package         | Purpose                                      |
| --------------- | -------------------------------------------- |
| `@ael/core`     | Contracts, config, fingerprints, statistics  |
| `@ael/runtime`  | Trial runtime, process/git/workspace control |
| `@ael/reporter` | Report generation from normalized evidence   |
| `@ael/cli`      | Commander-based `ael` CLI entrypoint         |

## Milestones

Delivery follows vertical slices documented in [ADR 0001](docs/adr/0001-vertical-slice-roadmap.md).
Complete **M0** platform hardening before starting **M1** runtime features.

Historical v1 plan (read-only reference): [docs/history/plan-v1-2026-07-30.md](docs/history/plan-v1-2026-07-30.md).
