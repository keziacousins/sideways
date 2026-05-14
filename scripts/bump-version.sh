#!/bin/bash
# Bump the version in the root package.json and every workspace package.
#
# Usage:
#   ./scripts/bump-version.sh patch        # 1.0.3 → 1.0.4
#   ./scripts/bump-version.sh minor        # 1.0.3 → 1.1.0
#   ./scripts/bump-version.sh major        # 1.0.3 → 2.0.0
#   ./scripts/bump-version.sh set 2.0.0    # explicit override (any valid semver)
#   ./scripts/bump-version.sh              # defaults to patch
#
# Versioning is manual, not automated. Bump only when cutting a release —
# i.e. you intend to publish a new CLI bundle, tag main, and surface a
# new version to users. Internal commits don't bump the version; semver
# is a signal to consumers, not a commit counter.
#
# After running, stage the changes, commit (e.g. `Release 1.1.0`), tag
# the commit, and deploy. See CLAUDE.md "Releasing" for the full flow.

set -e

LEVEL=${1:-patch}
PKG="package.json"

CURRENT=$(node -e "console.log(require('./$PKG').version)")

if [ "$LEVEL" = "set" ]; then
  NEW="${2:-}"
  if [ -z "$NEW" ] || ! [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
    echo "Usage: $0 set <semver>   (e.g. 2.0.0, 2.0.0-rc.1, 2.0.0+build.5)"
    exit 1
  fi
else
  IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
  case "$LEVEL" in
    major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
    minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
    patch) PATCH=$((PATCH + 1)) ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "Usage: $0 [patch|minor|major|set <semver>]"; exit 1 ;;
  esac
  NEW="$MAJOR.$MINOR.$PATCH"
fi

# Update root and all workspace package.json files
node -e "
const fs = require('fs');
const path = require('path');
const files = ['package.json', 'packages/cli/package.json', 'packages/server/package.json', 'packages/web/package.json', 'packages/mcp/package.json'];
for (const f of files) {
  try {
    const pkg = JSON.parse(fs.readFileSync(f, 'utf-8'));
    pkg.version = '$NEW';
    fs.writeFileSync(f, JSON.stringify(pkg, null, 2) + '\n');
  } catch {}
}
"

echo "$CURRENT → $NEW"
