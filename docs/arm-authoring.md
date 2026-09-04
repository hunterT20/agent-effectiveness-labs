# Arm authoring

An **arm** is the only intended difference between control and treatment in a comparison. Arms are
YAML documents validated by `ArmDocumentSchema` (`schemaVersion: 1`). Unknown fields are rejected.

Validate with:

```bash
ael arm validate path/to/arm.yaml
```

JSON Schema: `schemas/arm.schema.json`.

## Document shape

```yaml
schemaVersion: 1
id: baseline
name: Baseline (no overlay)
actions: []
```

| Field     | Meaning                                                                             |
| --------- | ----------------------------------------------------------------------------------- |
| `id`      | Referenced from `suite.yaml` (`primaryControlArm`, `primaryTreatmentArm`, `arms[]`) |
| `name`    | Human label for reports                                                             |
| `actions` | Ordered list of discriminated `type` objects (may be empty)                         |

The suite lists **paths** to arm files (`./arms/baseline.yaml`); the arm `id` inside the file must
match how statistics name control/treatment. Mismatch is a loaded-config error at plan/run time.

## Action types

`actions[]` is a Zod discriminated union on `type`. Each action is hashed into
`arm-materialization.json` (`actionHashes`) so resume can detect drift.

### `workspace-overlay`

```yaml
- type: workspace-overlay
  source: overlays/rules
```

Copies files from `source` (relative to the suite root) into the trial workspace. Content hashes
go into the overlay manifest. After the agent exits, `overlayIntegrity` compares hashes; a
treatment that rewrites its own overlay is `tampered` → `invalid_trial`.

Use this for skills, rules, AGENTS.md snippets, or `.cursor/policies` that should be **in** the
repo the agent sees.

### `home-overlay`

```yaml
- type: home-overlay
  source: overlays/fake-home
```

Copied into the trial-isolated HOME (not the operator's real home). Intended for agent CLI config
that lives under `$HOME`. Requires an isolation provider that actually isolates HOME
(`agent-cli-sandbox` or `container`). Under `directory-only` this is still applied in-process to
the workspace/home mapping the supervisor uses; it is **not** a security boundary.

### `environment`

```yaml
- type: environment
  variables:
    AEL_ARM: baseline
```

Keys are recorded in `environmentKeys`. Values that should not hit disk must be marked secret by
the process supervisor's redaction list — do not put long-lived tokens in arm YAML.

### `agent-argument`

```yaml
- type: agent-argument
  args: ['--flag', 'value']
```

Appended to the adapter argv (`argvAdditions`). Never a shell string.

### `plugin-directory`

```yaml
- type: plugin-directory
  path: plugins/awh
```

Passed through to adapters that understand plugin dirs (Cursor `--plugin-dir`). The path is
resolved against the suite root and must stay inside declared roots.

### `sandboxed-setup-command`

```yaml
- type: sandboxed-setup-command
  command: node
  args: [scripts/setup.mjs]
  cwd: .
  timeoutMs: 30000
```

Runs **via the isolation provider** after overlays, with cwd constrained to declared roots. A
setup that writes undeclared paths should fail the post-setup manifest diff. Command + args are
argv, `shell: false`.

## Baseline vs treatment

- **Baseline** arms typically set only an environment marker, or are empty, so the agent sees the
  unmodified seed.
- **Treatment** arms add overlays, plugins, or setup. Keep the treatment's extra surface area in
  the overlay, not in the fixture prompt — otherwise you have broken causal fairness.

Do not put the hidden grader, reference patches, or experiment output paths into an overlay.

## Fingerprints and resume

Arm documents are fingerprinted (RFC 8785 canonical JSON) as part of the suite identity. Changing
an overlay file changes content hashes even if YAML is unchanged. `ael resume` compares stored
fingerprints and records `CONFIG_DRIFT` instead of silently continuing.

## Doctor

`ArmProvider.doctor` is part of the arm contract. The built-in materializer reports `ready: false`
when overlay sources are missing. `ael doctor` today focuses on adapter + isolation; arm-source
existence is still checked at materialize time (trial then fails rather than doctor-failing).
Surface those errors at doctor time is **Planned**.

## Fairness checklist

1. Control and treatment share the same fixture prompts and graders.
2. Overlays do not leak the hidden grader or the expected patch.
3. Setup commands are deterministic and sandboxed.
4. No network downloads in setup unless the suite's isolation `network:` allows it **and** the
   provider actually enforces the policy (see [threat-model.md](threat-model.md)).
5. Validate both arms before sealing a plan: `ael arm validate` on each file.
