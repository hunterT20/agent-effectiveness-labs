# ADR 0002: GitHub pull request process

## Status

Accepted

## Context

The repository is developed by humans and coding agents. We need a single integration path that
preserves review, CI signal, and an auditable history without force-pushing to `main`.

## Decision

1. All changes land via **pull requests** into `main` from short-lived `feature/*` branches.
2. **CI must pass** on `ubuntu-latest` and `macos-latest` before merge. `windows-latest` is
   advisory (`continue-on-error: true`) until path and spawn parity is proven.
3. **No force push** to `main`. Hotfixes use a normal branch and PR.
4. **CODEOWNERS** applies default review routing; agents do not self-approve security-sensitive
   changes.
5. **Dependabot** opens weekly dependency PRs; humans merge after CI.
6. **Live or paid trials** require explicit human approval documented in the PR description, in
   addition to code review.

## Consequences

- `AGENTS.md` documents this workflow for automated contributors.
- Repository hosting on GitHub is required for CI, Dependabot, and PR governance.
- Agents run `pnpm verify` locally before opening a PR; CI is the merge gate.
