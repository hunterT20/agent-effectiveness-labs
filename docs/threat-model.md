# Threat model

Labs assumes **agent output and augmentation code may be adversarial**. A treatment arm that adds
skills, rules, or plugins is untrusted code executing next to the seed workspace. The harness must
still produce an auditable verdict, or refuse to produce one (`INSUFFICIENT_DATA`).

This document describes threats that the **current code** defends against, and the residual risk
when a capability is not observed. It is not a penetration-test report.

## Assets

| Asset                       | Why it matters                                                             |
| --------------------------- | -------------------------------------------------------------------------- |
| Hidden grader (`grader/**`) | Independent success criterion; if the agent can see it, grades are invalid |
| Seed repository + commit    | Causal baseline; mutation here is a fairness bug                           |
| Arm overlays                | The only intended difference between control and treatment                 |
| Experiment artifacts        | Reconstructability and resume; tampering looks like a different experiment |
| Secrets in env / logs       | Must not appear in public report views or bounded process logs             |
| Verdict                     | A `PASSED` that cannot be traced to evidence is a product failure          |

## Adversary

The primary adversary is the **agent process** (and any child it spawns), including:

- a malicious or confused treatment overlay (skills that rewrite tests, leak secrets, or escape);
- a `fake-agent` mode used in tests (`overlay-tamper`, `scope-escape`, `secret-leak`, …);
- a live `cursor-agent` that follows a prompt asking it to read outside the workspace.

The operator of `ael` is trusted to choose the suite, isolation provider, and whether to approve a
paid run. Third-party npm dependencies are in scope for supply-chain controls (see
[releasing.md](releasing.md)), not for this runtime threat model.

## Defenses (implemented)

| Threat                                    | Mitigation in this tree                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Read hidden grader                        | Grader copied into a **separate** grading workspace only after the agent process tree exits                       |
| Path escape from overlays / setup         | `isInside` containment; forbidden paths on the fixture; `sandboxed-setup-command` cwd must stay in declared roots |
| Overlay tampering during the trial        | Overlay manifest hashed before invoke; `overlayIntegrity: tampered` → `invalid_trial`                             |
| Agent-authored green tests as “proof”     | Hidden deterministic graders; visible tests in the seed are not a success signal                                  |
| Secret leakage in logs                    | `ProcessSupervisor` redaction stream (token regex + marked env values) **before** disk write                      |
| HTML / CSV injection in reports           | `escapeHtml`; CSV formula-injection prefix (`= + - @`) neutralized with a leading `'`                             |
| Config drift on resume                    | Fingerprints of suite, agent, isolation, pricing compared; mismatch → `CONFIG_DRIFT`                              |
| Concurrent writers on one experiment root | `ExperimentLock` via `open('wx')`                                                                                 |
| Shell injection                           | `spawn` argv arrays, `shell: false` everywhere in packages                                                        |
| Unknown config fields                     | Zod `.strict()` on suite / fixture / arm / pricing / persisted envelopes                                          |
| Stale lock takeover                       | Stale lock renamed to `lock.stale.<ts>.json` before a new `wx` create                                             |
| Network during synthetic release smoke    | `scripts/verify-release.mjs` unreachable registry **and** a `net`/`http`/`fetch` preload stub                     |

Adversarial coverage lives in `tests/adversarial/` (Vitest project `adversarial`).

## Isolation is observed, not advertised

Flags such as Cursor `--sandbox enabled` or Docker `--network none` are **inputs to a probe**, not
capabilities. `ael doctor` records `observedCapabilities`. If the suite `isolation.require.*` asks
for a capability that was not observed, doctor exits `3` and a conclusive verdict is refused.

| Capability                   | `directory-only` | `agent-cli-sandbox` | `container` (Docker)      |
| ---------------------------- | ---------------- | ------------------- | ------------------------- |
| `filesystemEnforced`         | never            | probe               | in-container probe        |
| `networkPolicyEnforced`      | never            | probe               | `--network none` + probe  |
| `processTreeEnforced`        | never            | never               | container lifetime        |
| `hiddenGraderProtected`      | never            | never               | grader root not mounted   |
| `externalArtifactsProtected` | never            | never               | artifact root not mounted |

`AEL_SKIP_SANDBOX_PROBE=1` forces every capability to unenforced. That is a CI convenience and is
**not** a production isolation mode.

## Blinded human rubric

Rating packets omit arm identity and shuffle presentation order from a seed (`ael grade export`).
Import rejects missing raters, incomplete criteria, or Cohen's kappa below policy. Those failures
are evidence problems → `INSUFFICIENT_DATA`, not a silent pass.

## Residual risk

- `directory-only` cannot protect graders or artifacts; it is synthetic-only.
- `agent-cli-sandbox` does not claim `processTreeEnforced` or grader/artifact protection.
- `ProtectedBlobStore` encryption is implemented in `@ael/runtime` but `ael run` does not yet pass
  `AEL_RUN_KEY_FILE` through (**Planned**).
- Telemetry parsers are version-gated; unknown Cursor log shapes degrade to `unavailable`, which
  must fail cost/token gates closed rather than invent numbers.
- Windows process-tree kill is best-effort (ADR 0003); Unix uses process-group kill (`-pid`).

## Fail closed

When required evidence is missing, Labs reports `INSUFFICIENT_DATA` instead of inventing support.
When a gate actually fails, the verdict is `FAILED`. There is no composite score that could hide
either outcome. See [README](../README.md#insufficient_data-examples).
