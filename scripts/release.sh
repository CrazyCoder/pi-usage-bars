#!/usr/bin/env bash
set -euo pipefail

BUN_VERSION="1.3.0"
YES=false
PHASE="prepare"
TARGET=""
BUN_TMP=""

usage() {
  cat <<'EOF'
Usage: scripts/release.sh <version> [prepare|publish|all] [--yes]

Examples:
  scripts/release.sh 0.4.1           # default: version, test, commit, and push
  scripts/release.sh 0.4.1 publish   # publish only, after reviewing preparation
  scripts/release.sh 0.4.1 all       # advanced: run prepare and publish consecutively

The default deliberately stops before npm publication. Review the pushed
release commit, then run the explicit publish phase. The publish phase uses
npm browser authentication and disables provenance,
which is unavailable for local publication. Run this script from a terminal
that can open or display the npm web-login URL.
EOF
}

for arg in "$@"; do
  case "$arg" in
    all|prepare|publish) PHASE="$arg" ;;
    --yes|-y) YES=true ;;
    --help|-h) usage; exit 0 ;;
    *)
      if [[ -z "$TARGET" ]]; then TARGET="$arg"
      else echo "Unexpected argument: $arg" >&2; usage >&2; exit 2
      fi
      ;;
  esac
done

if [[ -z "$TARGET" || ! "$TARGET" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "A stable semantic version such as 0.4.1 is required." >&2
  usage >&2
  exit 2
fi

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "Run this inside the pi-usage-bars Git repository." >&2
  exit 1
}
cd "$ROOT"

PACKAGE=$(node -p "require('./package.json').name")
[[ "$PACKAGE" == "@hk_net/pi-usage-bars" ]] || {
  echo "Unexpected package name: $PACKAGE" >&2
  exit 1
}
TAG="v$TARGET"

cleanup() {
  [[ -z "$BUN_TMP" ]] || rm -rf "$BUN_TMP"
}
trap cleanup EXIT

confirm() {
  local prompt=$1
  if $YES; then return 0; fi
  read -r -p "$prompt [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

ensure_main() {
  local branch
  branch=$(git branch --show-current)
  [[ "$branch" == "main" ]] || {
    echo "Release must run on main (currently: ${branch:-detached HEAD})." >&2
    exit 1
  }
}

ensure_clean() {
  [[ -z "$(git status --porcelain)" ]] || {
    echo "Working tree is not clean:" >&2
    git status --short >&2
    exit 1
  }
}

fetch_and_measure() {
  git fetch --prune origin
  git rev-parse --verify '@{upstream}' >/dev/null
  read -r AHEAD BEHIND < <(git rev-list --left-right --count HEAD...'@{upstream}')
}

ensure_synced() {
  fetch_and_measure
  if (( AHEAD != 0 || BEHIND != 0 )); then
    echo "main is not synchronized with @{upstream} (ahead=$AHEAD, behind=$BEHIND)." >&2
    exit 1
  fi
}

setup_bun() {
  if [[ -n "$BUN_TMP" ]]; then return; fi

  local os arch bun_package tarball
  case "$(uname -s)" in
    Linux) os="linux" ;;
    Darwin) os="darwin" ;;
    *) echo "Unsupported OS for temporary Bun setup: $(uname -s)" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="aarch64" ;;
    *) echo "Unsupported architecture for temporary Bun setup: $(uname -m)" >&2; exit 1 ;;
  esac

  bun_package="@oven/bun-${os}-${arch}"
  BUN_TMP=$(mktemp -d)
  tarball=$(npm pack "$bun_package@$BUN_VERSION" --pack-destination "$BUN_TMP" --silent | tail -n 1)
  tar -xzf "$BUN_TMP/$tarball" -C "$BUN_TMP"
  export PATH="$BUN_TMP/package/bin:$PATH"
  bun --version
}

run_checks() {
  npm ci
  setup_bun
  npm run check
  npm audit --omit=dev --audit-level=high
  npm pack --dry-run
}

registry_has_target() {
  [[ "$(npm view "$PACKAGE@$TARGET" version 2>/dev/null || true)" == "$TARGET" ]]
}

version_is_greater() {
  node - "$1" "$2" <<'NODE'
const current = process.argv[2].split(".").map(Number);
const target = process.argv[3].split(".").map(Number);
for (let i = 0; i < 3; i++) {
  if (target[i] > current[i]) process.exit(0);
  if (target[i] < current[i]) process.exit(1);
}
process.exit(1);
NODE
}

prepare() {
  ensure_main
  ensure_clean
  fetch_and_measure
  if (( AHEAD != 0 )); then
    echo "Local main has unpushed commits; inspect and push them before releasing." >&2
    exit 1
  fi
  if (( BEHIND != 0 )); then
    git pull --ff-only origin main
  fi
  ensure_clean

  local current
  current=$(node -p "require('./package.json').version")
  if [[ "$current" == "$TARGET" ]] && grep -Fq "## [$TARGET]" CHANGELOG.md; then
    echo "Release $TARGET is already prepared; run the publish phase."
    return
  fi
  [[ "$current" != "$TARGET" ]] || {
    echo "package.json is already $TARGET but CHANGELOG.md is not prepared." >&2
    exit 1
  }
  version_is_greater "$current" "$TARGET" || {
    echo "Target version $TARGET must be greater than current version $current." >&2
    exit 1
  }
  ! registry_has_target || {
    echo "$PACKAGE@$TARGET is already published." >&2
    exit 1
  }
  ! git show-ref --verify --quiet "refs/tags/$TAG" || {
    echo "Tag $TAG already exists." >&2
    exit 1
  }

  echo "Preparing $PACKAGE $current -> $TARGET"
  confirm "Continue with release preparation?" || { echo "Cancelled."; exit 1; }

  npm version "$TARGET" --no-git-tag-version
  TARGET="$TARGET" RELEASE_DATE="$(date -u +%Y-%m-%d)" python3 <<'PY'
import os
from pathlib import Path

path = Path("CHANGELOG.md")
text = path.read_text()
marker = "## Unreleased"
if text.count(marker) != 1:
    raise SystemExit("CHANGELOG.md must contain exactly one '## Unreleased' heading")
start = text.index(marker) + len(marker)
next_release = text.find("\n## [", start)
body = text[start:next_release if next_release != -1 else len(text)].strip()
if not body:
    raise SystemExit("The Unreleased changelog section is empty")
replacement = f"{marker}\n\n## [{os.environ['TARGET']}] - {os.environ['RELEASE_DATE']}"
path.write_text(text.replace(marker, replacement, 1))
PY

  run_checks
  git diff --check
  git diff -- package.json package-lock.json CHANGELOG.md
  git add package.json package-lock.json CHANGELOG.md
  git commit -m "release: $TAG"

  fetch_and_measure
  if (( BEHIND != 0 )); then
    echo "origin/main changed during preparation; rebase and rerun checks before pushing." >&2
    exit 1
  fi
  git push origin main
  echo "Prepared and pushed $TAG source."
}

verify_or_create_tag() {
  git fetch --prune origin --tags
  if git show-ref --verify --quiet "refs/tags/$TAG"; then
    local tagged
    tagged=$(git rev-list -n 1 "$TAG")
    [[ "$tagged" == "$(git rev-parse HEAD)" ]] || {
      echo "Existing tag $TAG does not point to HEAD." >&2
      exit 1
    }
    echo "Tag $TAG already points to HEAD."
    return
  fi
  git tag -a "$TAG" -m "Release $TAG"
  git push origin "$TAG"
}

publish_release() {
  ensure_main
  ensure_clean
  ensure_synced

  local current
  current=$(node -p "require('./package.json').version")
  [[ "$current" == "$TARGET" ]] || {
    echo "package.json is $current, not requested version $TARGET." >&2
    exit 1
  }
  grep -Fq "## [$TARGET]" CHANGELOG.md || {
    echo "CHANGELOG.md has no $TARGET release heading." >&2
    exit 1
  }

  if registry_has_target; then
    echo "$PACKAGE@$TARGET is already visible on npm; skipping publication."
  else
    run_checks
    npm whoami >/dev/null 2>&1 || npm login --auth-type=web
    echo "Authenticated to npm as $(npm whoami)."
    echo "Registry currently reports latest: $(npm view "$PACKAGE" version 2>/dev/null || echo unpublished)"
    confirm "Publish $PACKAGE@$TARGET publicly to npm?" || { echo "Cancelled."; exit 1; }

    if ! npm publish --access public --provenance=false; then
      if registry_has_target; then
        echo "Publish returned an error, but $PACKAGE@$TARGET is visible; continuing verification."
      else
        echo "Publish failed and $PACKAGE@$TARGET is not visible. Do not retry blindly." >&2
        exit 1
      fi
    fi
  fi

  local visible=false
  for _ in {1..12}; do
    if registry_has_target; then visible=true; break; fi
    sleep 5
  done
  $visible || { echo "$PACKAGE@$TARGET did not become visible on npm." >&2; exit 1; }

  npm view "$PACKAGE" version dist-tags.latest
  npm view "$PACKAGE@$TARGET" dist.integrity
  verify_or_create_tag
  echo "Released $PACKAGE@$TARGET and tagged $TAG."
}

case "$PHASE" in
  prepare) prepare ;;
  publish) publish_release ;;
  all) prepare; publish_release ;;
esac
