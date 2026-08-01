# Agent Effectiveness Labs — Agent Instructions

This repository implements **Agent Effectiveness Labs** (`ael`), a standalone benchmark harness for measuring coding-agent effectiveness under controlled, auditable conditions.

## Mandatory safety and trust rules

All contributors and automated agents working in this repository must follow these rules without exception.

### Live and paid trials

- **Do not** run live or paid agent trials without explicit human approval.
- Approval must document the exact model, trial count, timeout, telemetry capability, and advisory cost/token ceiling.
- CI and default test runs must keep live tests disabled.

### Independent grading

- Agent self-reports, CLI exit codes, and agent-authored green tests are **not** proof of success.
- Graders run independently after agent exit against hidden or isolated criteria.
- Never collapse status, grade dimensions, or evidence quality into a single unverifiable score.

### Sandbox and process execution

- Execute external programs with `child_process.spawn` (or equivalent) using **argv arrays** and **`shell: false`**.
- Never build shell command strings for subprocess invocation.
- Respect workspace isolation, setup sandboxes, and bounded resource limits defined by the runtime.

### External artifacts

- Parse external JSON/YAML as `unknown` and reject unknown fields.
- Canonicalize and fingerprint suite, fixture, arm, adapter, pricing, and run-plan inputs before trusting them.
- Redact secrets from logs, commands, environment, and report views before persistence.
- Candidate blobs required for reconstruction must be encrypted before persistence and never rendered in public views.

### Configuration and evidence

- Fail closed when required evidence is missing; report `INSUFFICIENT_DATA` instead of inventing support.
- Preserve append-only, auditable evidence with atomic checkpoints.
- Do not silently downgrade trust or claim unsupported capabilities.

## Development workflow

- Use Node.js `>=24` and pnpm `9.15.0` (see root `packageManager` field).
- Follow TDD: write a focused failing test, implement the minimum change, verify green.
- Run `pnpm verify` before considering work complete (`format` + `lint` + `typecheck` + `build` + `test`).

## Package layout

| Package         | Purpose                                      |
| --------------- | -------------------------------------------- |
| `@ael/core`     | Contracts, config, fingerprints, statistics  |
| `@ael/runtime`  | Trial runtime, process/git/workspace control |
| `@ael/reporter` | Report generation from normalized evidence   |
| `@ael/cli`      | Commander-based `ael` CLI entrypoint         |
