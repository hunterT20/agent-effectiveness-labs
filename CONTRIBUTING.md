# Contributing to Agent Effectiveness Labs

Thank you for contributing to `ael`. This project measures coding-agent effectiveness under
controlled, auditable conditions—changes must preserve fail-closed behavior and evidence integrity.

## Prerequisites

- Node.js `>=24`
- pnpm `9.15.0` (see root `packageManager`)

```bash
source ~/.nvm/nvm.sh && nvm use 24   # if using nvm
pnpm install
pnpm verify
```

## Development workflow

1. Create a branch from `main`: `feature/<short-description>`.
2. Follow **TDD**: add or extend a focused failing test, implement the minimum fix, run
   `pnpm verify`.
3. Keep diffs scoped to the milestone or task you are delivering.
4. Open a **pull request** to `main` (see [ADR 0002](docs/adr/0002-github-pr-process.md)).
5. Ensure CI passes on **ubuntu-latest** and **macos-latest**.

## Code standards

- TypeScript `strict` mode; no `any`.
- Parse external JSON/YAML as `unknown`; validate with Zod.
- Use `child_process.spawn` with argv arrays and `shell: false` for subprocesses.
- Do not run live or paid agent trials without explicit approval in the PR.

## Project layout

| Package         | Role                                        |
| --------------- | ------------------------------------------- |
| `@ael/core`     | Contracts, config, fingerprints             |
| `@ael/runtime`  | Trial runtime, artifacts, workspace control |
| `@ael/reporter` | Report generation                           |
| `@ael/cli`      | `ael` CLI entrypoint                        |

## Tests

Vitest projects: `unit`, `integration`, `adversarial`, `live` (see `vitest.config.ts`).

```bash
pnpm test                              # all projects with matching tests
pnpm --dir packages/core test          # unit tests for core only
```

Live Cursor tests require `AEL_LIVE_CURSOR=1` and human approval. CI never sets it.
`AEL_LIVE_TESTS` is not read by any code.

## Documentation

- Architecture and methodology: `docs/`
- Agent instructions: `AGENTS.md`
- ADRs: `docs/adr/`
