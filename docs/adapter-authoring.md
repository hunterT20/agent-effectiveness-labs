# Adapter authoring

Agents talk to AEL through an **adapter** (`AgentAdapter` in `@ael/core`). The harness never builds
shell strings; adapters return a `ProcessInvocation` `{ command, args, cwd, env, timeoutMs }` that
the isolation provider passes to `child_process.spawn` (`shell: false`).

## Contract (`contractVersion: 1`)

| Method             | Role                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------- |
| `doctor`           | Readiness **without** a billed invoke: binary present, version, optional sandbox probe |
| `buildInvocation`  | argv-safe spawn spec for one phase (`promptFile`, `workspaceRoot`, `sessionMode`, …)   |
| `parseOutcome`     | Did the process complete? Any response artifacts? Optional `sessionChatId` for resume  |
| `collectTelemetry` | Token / tool-call metrics with `quality` (`exact` \| `estimated` \| `unavailable`)     |

Optional `capabilities`:

| Flag                  | Meaning                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `resume`              | Adapter can continue a prior chat (`session: resume` phases)     |
| `streamJsonTelemetry` | Structured log that a version-gated parser understands           |
| `sandboxProbe`        | Adapter can run an isolation probe (used by `agent-cli-sandbox`) |

`ael plan` fails (exit `2`) when a fixture needs resume and `capabilities.resume` is false.

## Built-in adapters

Registered through `registerAdapter` / `getAdapter` in `@ael/runtime`.

### `fake-agent`

Used by CI and `scripts/verify-*.mjs`. The CLI spawns `node <fake-agent-path>` via
`createCustomCommandAdapter('fake-agent', …)`. The script shipped in this repository is
`tests/fake-agent/fake-agent.mjs` and is **not** inside the npm tarball — pass `--fake-agent`
explicitly after `npm install @ael/cli`.

Behaviour is selected with `AEL_FAKE_MODE` (`success`, `incorrect`, `timeout`, `claims-done`,
`overlay-tamper`, `scope-escape`, `secret-leak`, …). Telemetry for unknown modes is `unavailable`.

### `cursor`

`createCursorAdapter` wraps `cursor-agent`. Version is parsed from `cursor-agent --version` and
checked against `TESTED_CURSOR_VERSION_RANGES`. Invocation uses `--print --output-format stream-json
--trust --sandbox enabled --workspace <ws> --model <m>` plus optional `--plugin-dir` and
`--resume <chatId>`. `HOME` / `XDG_*` are pointed at a trial-isolated directory.

**Live invokes are paid.** `ael run` currently **refuses** `adapter: cursor` with exit `3`
(`cursor live runs are not authorized without Holdpoint B approval`). `AEL_APPROVE_LIVE_RUN` is
**Planned**. Unit tests use frozen redacted logs under `tests/fixtures/cursor-logs/`. You may run
`cursor-agent --version` / `--help` locally; do not pass a prompt without documented approval.

### `custom-command`

Any other `suite.agent.adapter` string is treated as an executable name:
`createCustomCommandAdapter(id, { command, extraArgs, timeoutMs })`. The adapter still has to
honour argv-only spawn. If the third-party CLI needs a shell, wrap it in a small Node script that
you control — do not set `shell: true`.

## Doctor vs invoke

`ael doctor --suite <suite.yaml>` calls adapter `doctor` and isolation `doctor` only. It must not
start a billed generation. For Cursor, a Holdpoint B reminder is always printed on stderr.

`AEL_SKIP_SANDBOX_PROBE=1` skips the live sandbox probe and reports all isolation capabilities as
unenforced. Use it in CI; never for a live trust-hardened suite.

## Telemetry quality

`collectTelemetry` must fill every metric with a `MetricValue`: a number plus `quality` and a
`coverageReason` when not `exact`. Unknown output shapes **degrade to `unavailable`**. Cost gates
that need tokens then fail closed (`INSUFFICIENT_DATA`), they do not invent spend.

The Cursor extractor is version-gated (`cursorExtractor` / `streamJson`). Raw logs stay on disk
when parsing fails.

## Writing a new adapter

1. Implement `AgentAdapter` in a module that the CLI can import, **or** expose a CLI that
   `custom-command` can spawn.
2. Keep `doctor` side-effect free except for `--version`-class probes.
3. Pass the prompt as a **file path**, not as an interpolated argv string that could break on
   whitespace.
4. Record `version` on the doctor result so reports can say which binary ran.
5. Add frozen fixtures for the log parser; do not require live calls in unit tests.
6. If you need resume, set `capabilities.resume: true` and honour `resumeChatId`.
7. Never treat the agent CLI exit code as task success — that is the hidden grader's job.

A first-class Codex adapter (`--ephemeral`, sandbox flags) is **M5 / v1.1**, not v1.

## Isolation pairing

Adapters do not enforce sandboxing by themselves. Pair them:

| Adapter      | Typical isolation                                         |
| ------------ | --------------------------------------------------------- |
| `fake-agent` | `directory-only`                                          |
| `cursor`     | `agent-cli-sandbox`                                       |
| custom CLI   | `directory-only` or `container` depending on threat model |

See [README](../README.md#boundary-of-universal-support).
