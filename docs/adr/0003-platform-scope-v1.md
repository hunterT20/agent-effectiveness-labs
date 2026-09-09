# ADR 0003: Platform scope for v1

## Status

Accepted

## Context

v1 must be provider-neutral and auditable while remaining shippable. We must bound OS support,
runtime dependencies, and trust boundaries up front.

## Decision

**In scope for v1**

- Node.js `>=24`, TypeScript ESM, pnpm workspace, Vitest projects (`unit`, `integration`,
  `adversarial`, `live`).
- Local Git fixtures, argv-safe `child_process.spawn` (`shell: false`), append-only JSON/NDJSON
  evidence with atomic checkpoints.
- Strict Zod validation for manifests and persisted artifacts; RFC 8785 fingerprints for identity.
- Built-in and `custom-command` agent adapters; directory-only isolation as the baseline provider.
- Static report generation from normalized evidence (JSON source, CSV/Markdown/HTML views).

**Out of scope for v1**

- Remote execution, Kubernetes, dashboard servers, or benchmark marketplaces.
- Reading or storing private chain of thought.
- Treating agent self-report or CLI exit code as proof of success.
- SQLite as source of truth (may be added later as a read-only index).

**Platform targets**

- **Required CI:** Linux (`ubuntu-latest`), macOS (`macos-latest`).
- **Advisory CI:** Windows (`windows-latest`, non-blocking).
- Path containment uses `path.relative` semantics (see M0.2), not string prefix checks.

## Consequences

- Features outside this scope require a new ADR or a v2 milestone.
- Windows-specific behavior is tested when possible but does not block merge.
- M1 runtime work assumes M0 artifact and config contracts are stable.
