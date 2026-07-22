# Releasing

This repository uses semantic versions. The package version, changelog heading, Git tag, and npm version must agree.

The npm publish workflow is manual-only. Pushing a Git tag does not publish the package, which prevents a tag pushed after a local npm release from attempting to publish the same version twice.

## Prerequisites

- Write access to `hknet/pi-usage-bars`.
- Publish access to the npm scope `@hk_net`.
- npm authentication for the `hk_net` account (`npm whoami`).
- Node.js 22.19 or newer.
- Bun 1.3.0. The commands below use a temporary pinned Bun installation, so a global Bun installation is not required.

Never place an npm token in the repository, command history, or endpoint override. Complete npm's browser or OTP authorization when prompted.

## 1. Verify the source release

From the repository root:

```bash
git switch main
git pull --ff-only origin main
git status --short
node -p "require('./package.json').version"
```

For this release, the version must be `0.4.0` and the working tree must be clean.

Run the same checks used by CI and npm's `prepublishOnly` hook:

```bash
npx --yes --package bun@1.3.0 -- npm run check
npm audit --omit=dev --audit-level=high
npm pack --dry-run
```

Expected results for `0.4.0`:

- strict TypeScript check passes;
- 32 tests pass;
- Pi smoke test passes;
- production audit has no vulnerabilities;
- the dry-run package is `@hk_net/pi-usage-bars@0.4.0` and contains the extension, documentation, changelog, and license.

## 2. Verify npm state

```bash
npm whoami
npm view @hk_net/pi-usage-bars version
```

Before publishing `0.4.0`, the registry should still report `0.3.0`. If it already reports `0.4.0`, do not publish it again.

Optionally inspect exactly what npm will receive:

```bash
npm pack --dry-run --json
```

## 3. Publish manually

Local npm publication cannot use GitHub's OIDC provenance attestation, so explicitly disable provenance for this manual release:

```bash
npx --yes --package bun@1.3.0 -- \
  npm publish --access public --provenance=false
```

The `prepublishOnly` hook reruns the complete check. Complete the npm browser/OTP authorization if requested. Do not retry blindly after an ambiguous network failure; verify the registry first.

## 4. Verify the published package

```bash
npm view @hk_net/pi-usage-bars version dist-tags.latest
npm view @hk_net/pi-usage-bars@0.4.0 dist.integrity
```

Both version values should report `0.4.0`, and the integrity field should be present.

Test installation or update through Pi:

```bash
pi install npm:@hk_net/pi-usage-bars
# If it is already installed:
pi update npm:@hk_net/pi-usage-bars
```

Restart Pi, or use `/reload`, then run `/usage`.

## 5. Tag the verified source

Only tag after npm verification succeeds:

```bash
git switch main
git pull --ff-only origin main
git tag -a v0.4.0 -m "Release v0.4.0"
git push origin v0.4.0
```

The tag does not trigger npm publication. It records the exact source corresponding to the already-published package. A GitHub release can then be created from `v0.4.0` using the `0.4.0` changelog section.

## CI publishing alternative

The **Publish to npm (manual)** GitHub Actions workflow remains available as an alternative. It requires the `NPM_TOKEN` repository secret and publishes with npm provenance. Do not run it after publishing the same version locally.
