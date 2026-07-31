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

This **default command only prepares the release**. It deliberately stops before npm login or publication, so the pushed release commit can be reviewed first. The launcher first executes an immutable temporary copy of itself, so editing the script while a release is running cannot corrupt that run.

Preparation:

1. verifies that `main` is clean and synchronized with `origin/main`;
2. rejects an existing npm version or Git tag;
3. updates `package.json` and `package-lock.json` without creating an early tag;
4. promotes the `Unreleased` changelog entries into a dated release while preserving an empty `Unreleased` heading;
5. installs dependencies with `npm ci --no-audit`, provisions a temporary pinned Bun binary, and runs typecheck, tests, detailed dependency audits, and package dry-run; and
6. commits and pushes the release source.

After reviewing the prepared commit, publish explicitly:

```bash
scripts/release.sh 0.4.1 publish
```

`publish` requires the prepared source to be clean and exactly synchronized with the remote, then starts `npm login --auth-type=web` when needed, prompts before `npm publish --access public --provenance=false`, verifies the registry version/integrity, and creates and pushes the annotated tag.

Use `--yes` only in an attended environment where npm authentication is already configured:

```bash
scripts/release.sh 0.4.1 --yes          # prepare only
scripts/release.sh 0.4.1 publish --yes  # publish after review
```

## Recovery and advanced mode

The publish phase is safe to rerun after an ambiguous network response: if the exact version is already visible on npm, it skips republishing and completes verification/tagging. Never retry publication blindly and never force-push a release tag.

The release script first prints a full dependency audit with package names, dependency paths, affected ranges, and available fixes. This is informational because it includes development-only dependencies. It then runs a blocking production-only audit, which rejects high or critical production findings.

`all` is available only as an explicit advanced mode and runs preparation and publication consecutively:

```bash
scripts/release.sh 0.4.1 all
```

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
