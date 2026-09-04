# Changesets

This monorepo uses [@changesets/cli](https://github.com/changesets/changesets) for semver and
CHANGELOG generation. The four public packages (`@ael/core`, `@ael/runtime`, `@ael/reporter`,
`@ael/cli`) are in a **fixed** group: they always share one version number.

```bash
pnpm changeset            # describe a change (pick packages + bump type)
pnpm changeset status --since origin/main
                          # validate pending changesets (CI fetches origin/main then runs this)
pnpm changeset version    # consume changesets -> bump versions + CHANGELOG.md (release manager only)
pnpm changeset publish    # publish to npm (CI release workflow only, with provenance)
```

Package versions in `packages/*/package.json` stay at the last released version; do **not** bump
them by hand. The full procedure lives in [docs/releasing.md](../docs/releasing.md).
