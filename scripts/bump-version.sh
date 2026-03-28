#!/bin/bash
# Bump patch version in root package.json.
# Usage: ./scripts/bump-version.sh [minor|major]
# Default: patch

set -e

LEVEL=${1:-patch}
PKG="package.json"

CURRENT=$(node -e "console.log(require('./$PKG').version)")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$LEVEL" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
  *) echo "Usage: $0 [patch|minor|major]"; exit 1 ;;
esac

NEW="$MAJOR.$MINOR.$PATCH"

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
