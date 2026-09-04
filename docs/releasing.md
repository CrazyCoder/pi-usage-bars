# Releasing

The package version, changelog heading, Git tag, and npm version must agree.
GitHub Actions publishes tagged releases through npm trusted publishing and then
creates the GitHub release.

## First npm release

npm cannot attach a trusted publisher before the package exists. Publish the
first version once from a clean local checkout:

```bash
npm ci
npm run check
npm run verify:tarball
npm login --auth-type=web
npm publish --access public
```

After npm shows the package, configure its trusted publisher with these values:

- organization or user: `CrazyCoder`
- repository: `pi-usage-bars`
- workflow: `publish.yml`
- environment: leave empty

Push the matching `v0.7.0` tag after the manual publish. The workflow recognizes
that npm already has this version, reruns every gate, skips publication, and
creates the GitHub release.

## Later releases

1. Update `package.json` and `package-lock.json` to the next semantic version.
2. Move the relevant changelog entries from `Unreleased` into a dated version.
3. Run `npm ci`, `npm run check`, and `npm run verify:tarball`.
4. Commit the release and tag that commit as `v<version>`.
5. Push `main` and the tag.

The workflow refuses to publish when the tag differs from `package.json`, points
at another commit, or is not on `main`. It upgrades to npm 11 because npm 12 has
failed provenance publishing with a missing `sigstore` module.

Use the workflow's manual `dry_run` input to exercise installation, tests, and
tarball verification without publishing.

## Post-release check

```bash
pi install npm:@jetserge/pi-usage-bars
# Existing installation:
pi update npm:@jetserge/pi-usage-bars
```

Restart Pi or use `/reload`, then run `/usage`.
