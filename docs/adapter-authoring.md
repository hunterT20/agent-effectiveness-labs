# Adapter authoring

Agents integrate via **adapters** implementing the capability contract:

- `doctor` — readiness without invocation
- `invoke` — argv-safe spawn with timeout and sandbox flags
- `capabilities` — resume, telemetry, sandbox support

Built-in: `fake-agent` (synthetic), `cursor` (live behind Holdpoint B). Custom agents use
`custom-command` with explicit command and args.

Version and parser capability are recorded in experiment artifacts. Unknown output shapes degrade
telemetry to `unavailable`, not correctness.
