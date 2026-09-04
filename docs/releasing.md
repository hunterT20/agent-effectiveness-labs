# Releasing Agent Effectiveness Labs

This is the release procedure for the four public packages `@ael/core`, `@ael/runtime`,
`@ael/reporter`, and `@ael/cli`. They are a **fixed** Changesets group: one version number, one
npm provenance set, one Git tag `vX.Y.Z`.

**Do not** bump `packages/*/package.json` `version` by hand. **Do not** run `pnpm changeset version`
on a random feature branch — that command consumes changesets and writes `CHANGELOG.md`. The
release manager runs it on a dedicated PR.

This branch ships the machinery. It does **not** publish, tag, or push.

## What “released” means

A version is released when **all** of the following are true:

1. A Changesets version PR has merged to `main` (versions + changelogs updated, pending
   `.changeset/*.md` consumed except `README.md`).
2. Git tag `vX.Y.Z` matches `packages/cli/package.json` `version`.
3. GitHub Actions workflow [release.yml](../.github/workflows/release.yml) finished:
   `pnpm verify`, `node scripts/verify-release.mjs`, CycloneDX SBOM uploaded, `pnpm changeset
publish` with `NPM_CONFIG_PROVENANCE=true`, GitHub Release attached to the tag.
4. `npm view @ael/cli@X.Y.Z` shows provenance (`publishConfig.provenance: true` on each package).

## Package versions in this repository

Until the first version PR, public packages sit at `0.0.0`. The pending changeset
`.changeset/m4-enterprise-release.md` requests a **major** bump for all four packages, which
Changesets will turn into `1.0.0` when `pnpm changeset version` runs.

The private workspace root (`agent-effectiveness-labs`) is not published.

## Local checklist (every PR)

```bash
source ~/.nvm/nvm.sh && nvm use 24
pnpm install --frozen-lockfile
pnpm verify
pnpm changeset status --since origin/main
```

`pnpm verify` is `format && build && lint && test:coverage && knip && publint`. It does **not**
run `changeset version` or `changeset publish`.

`changeset status` needs a `main` ref. On a shallow clone:

```bash
git fetch origin main --depth=1
pnpm changeset status --since origin/main
```

CI’s ubuntu job runs the same status check after fetching `origin/main`.

## Adding a changeset

```bash
pnpm changeset
```

Pick the packages that changed. Because of `fixed`, bumping one public package bumps all four to
the same version; still list all four (or rely on the fixed group). Use `major` / `minor` /
`patch` according to semver of the **public CLI/API**, not according to milestone numbers.

Commit the new `.changeset/<name>.md` with the feature. Do not edit `CHANGELOG.md` by hand.

## Release manager: cut `v1.0.0` (and later)

1. Ensure `main` is green (ubuntu + macos required checks).
2. On a branch from `main`: `pnpm changeset version`.
3. Review the generated `CHANGELOG.md` files and version fields. Commit (`chore(release): …`).
4. Open a PR. Merge when CI is green.
5. On `main`: `git tag v1.0.0 && git push origin v1.0.0`.
   The tag **must** match the package version. The workflow refuses a mismatch and refuses leftover
   unconsumed changesets.
6. Wait for `Release` / `publish v1.0.0`. The job uses environment `npm-publish` (configure
   `NPM_TOKEN` and trust the `id-token` for provenance).
7. Confirm the GitHub Release contains `sbom.cdx.json` and that npm shows provenance.

Never run `pnpm changeset publish` from a laptop if CI can do it: provenance is tied to the GitHub
Actions identity.

## `scripts/verify-release.mjs`

Offline pack + install smoke (roadmap M4.5 / M4.6):

- Requires `pnpm build` first (`dist/` in each package).
- Initializes `examples/minimal` seed repo.
- `pnpm pack` of all four packages into `os.tmpdir()`.
- `npm init -y && npm install <tarballs>` in a fresh temp project (this step may use the registry
  for third-party deps: commander, zod, yaml, …).
- Runs installed `ael --version`, `suite validate`, `plan --json`, `run` (fake agent), `report`
  with `npm_config_registry` pointed at `http://127.0.0.1:9/` **and** a Node `--require` preload
  that stubs `net` / `tls` / `http(s)` / `dns` / `fetch`.
- Asserts `LICENSE` is inside each installed package.

`--keep` leaves the temp directory for debugging.

## `scripts/verify-synthetic.mjs`

Performance smoke (M4.7): 30 fake-agent trials in under 5 minutes, using
`examples/minimal/suite-perf.yaml` when present. If that file is missing (other branches add it),
the script falls back to `suite.yaml` and **warns**; it then asserts whatever `trial-plan.json`
planned rather than hard-coding 30.

## Coverage gate

`vitest` coverage is configured at the **top level** (`test.coverage`), include
`packages/core/src/**` and `packages/runtime/src/**`. Roadmap target is 85% lines/statements/
functions and 70% branches. Until the parallel test wave lands, thresholds are the last measured
values rounded down, with a `TODO(release-integration)` in `vitest.config.ts`.

## Supply chain

| Control         | Where                                                |
| --------------- | ---------------------------------------------------- |
| Frozen lockfile | `pnpm install --frozen-lockfile` in CI and release   |
| Advisory audit  | Job `audit` in `ci.yml` (`continue-on-error`, retry) |
| Dependabot      | npm weekly + github-actions weekly                   |
| Gitleaks        | `.github/workflows/secret-scan.yml`                  |
| SBOM            | CycloneDX JSON artifact on the GitHub Release        |
| Provenance      | `NPM_CONFIG_PROVENANCE=true` + `id-token: write`     |
| License         | MIT; `LICENSE` copied into each public package       |

`tsc --isolatedDeclarations` is **not** enabled: enabling it fails `@ael/core` on Zod schema
exports that lack explicit type annotations (fifty-plus errors under `packages/core/src`). Do not
turn it on from a release PR; it needs a dedicated types pass in `packages/*/src`.

`@ael/core` pins `json-canonicalize` to **exactly** `2.0.0`. `^2.0.0` resolves to `2.0.1` on npm,
and that tarball is source-only (no `bundles/index.umd.js`), so a fresh `npm install` of the packed
CLI cannot load fingerprints. Do not widen the range until upstream ships a usable 2.x.

Until `isDirectExecution` in `@ael/cli` compares realpaths, always invoke the packed CLI via
`fs.realpathSync` (macOS `/var` → `/private/var`). `npx ael` may otherwise start and exit 0
without running Commander.

## GitHub environment

Create an Environment named `npm-publish` with secret `NPM_TOKEN` (automation token that can
publish `@ael/*`). Restrict it to tags `v*` if possible. Provenance also needs the default
`GITHUB_TOKEN` permissions already set in `release.yml` (`contents: write`, `id-token: write`).
