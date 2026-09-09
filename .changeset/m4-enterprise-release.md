---
'@ael/core': major
'@ael/runtime': major
'@ael/reporter': major
'@ael/cli': major
---

First stable release of Agent Effectiveness Labs (`ael`) — the M0–M4 roadmap.

- **Contracts & config** (`@ael/core`): strict Zod schemas for suite, fixture, arm and pricing
  documents (unknown fields rejected), canonical fingerprints, deterministic seeded scheduler with
  `trial-plan.json` / `preregistration.json`, fixture-cluster statistics (paired sign test, cluster
  bootstrap, Holm correction, power/readiness, Cohen's kappa) and preregistered decision gates that
  yield `PASSED` / `FAILED` / `INSUFFICIENT_DATA` — never a composite score.
- **Runtime** (`@ael/runtime`): `directory-only`, `agent-cli-sandbox` and `container` (Docker)
  isolation providers with observed-capability doctor probes; `fake-agent`, `custom-command` and
  version-gated `cursor` adapters; seed workspaces cloned at a pinned commit; arm materialization
  (overlays, environment, agent arguments, plugin directories, sandboxed setup); candidate
  snapshots with overlay-integrity checks; hidden deterministic graders executed after agent exit;
  checkpointed trial state machine with strict resume and `CONFIG_DRIFT` detection; redacted,
  bounded process logs; encrypted protected blobs; telemetry provenance and pricing snapshots;
  blinded rubric export/import.
- **Reporter** (`@ael/reporter`): deterministic JSON source of truth plus Markdown, CSV
  (formula-injection safe) and self-contained HTML views.
- **CLI** (`@ael/cli`): `ael suite|fixture|arm validate`, `fixture self-test`, `doctor`, `plan`,
  `run`, `resume`, `status`, `report`, `grade export|import` with the exit-code contract
  `0` ok / `2` config / `3` capability / `4` runtime / `5` verdict.
