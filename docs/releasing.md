# Releasing

This repository uses semantic versions. The package version, changelog heading, Git tag, and npm version must agree.

Local publication uses npm browser authentication. The GitHub Actions publish workflow is manual-only; pushing a tag does not publish the package.

## Prerequisites

- Write access to `hknet/pi-usage-bars`.
- Publish access to the npm scope `@hk_net`.
- Node.js 22.19 or newer.
- A clean, synchronized `main` branch.

Never place an npm token in the repository, command history, or endpoint configuration. Complete npm's browser or OTP authorization when prompted.

## Recommended release script

From the repository root, provide the exact new semantic version:

```bash
cd /path/to/pi-usage-bars
scripts/release.sh 0.4.1
```

The script:

1. verifies that `main` is clean and synchronized with `origin/main`;
2. rejects an existing npm version or Git tag;
3. updates `package.json` and `package-lock.json` without creating an early tag;
4. promotes the `Unreleased` changelog entries into a dated release while preserving an empty `Unreleased` heading;
5. installs dependencies with `npm ci`, provisions a temporary pinned Bun binary, and runs typecheck, tests, the Pi smoke test, production audit, and package dry-run;
6. commits and pushes the release source;
7. starts `npm login --auth-type=web` when needed;
8. prompts before `npm publish --access public --provenance=false`;
9. verifies the registry version and integrity; and
10. creates and pushes the annotated tag only after npm verification succeeds.

Use `--yes` only in an attended environment where npm authentication is already configured:

```bash
scripts/release.sh 0.4.1 --yes
```

## Split workflow and recovery

The release can be split around browser authentication or handed between maintainers:

```bash
scripts/release.sh 0.4.1 prepare
scripts/release.sh 0.4.1 publish
```

`prepare` performs versioning, checks, commit, and source push. `publish` requires the prepared source to be clean and exactly synchronized with the remote, then performs browser login, npm publication, verification, and tagging.

The publish phase is safe to rerun after an ambiguous network response: if the exact version is already visible on npm, it skips republishing and completes verification/tagging. Never retry publication blindly and never force-push a release tag.

Show script help with:

```bash
scripts/release.sh --help
```

## Post-release verification

Confirm installation through Pi:

```bash
pi install npm:@hk_net/pi-usage-bars
# If already installed from npm:
pi update npm:@hk_net/pi-usage-bars
```

Restart Pi, or use `/reload`, then run `/usage`.

## GitHub Actions alternative

The **Publish to npm (manual)** workflow is available as an alternative. It requires the `NPM_TOKEN` repository secret and publishes with npm provenance. Do not run it after publishing the same version locally.
