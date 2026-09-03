# Arm authoring

Arms declare bounded `actions` applied before each trial:

- `home-overlay`, `workspace-overlay`
- `environment`, `agent-argument`, `plugin-directory`
- `sandboxed-setup-command`

Baseline arms typically set only environment markers. Treatment arms add overlays or plugins.

Validate with:

```bash
ael arm validate arms/my-arm.yaml
```

Arm fingerprints are sealed into the trial plan; drift blocks resume.
