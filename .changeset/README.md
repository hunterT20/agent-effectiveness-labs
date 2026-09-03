# Changesets

This monorepo uses [@changesets/cli](https://github.com/changesets/changesets) for semver and
CHANGELOG generation.

```bash
pnpm changeset
pnpm changeset version
pnpm changeset publish
```

v1.0.0 packages: `@ael/core`, `@ael/runtime`, `@ael/reporter`, `@ael/cli`.

npm provenance: publish from CI with `NPM_CONFIG_PROVENANCE=true`.
