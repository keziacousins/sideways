#!/usr/bin/env bash
# Mirror brand fonts out of `brand/` into the locations the builds read from.
#
# `brand/` is gitignored and is the single source of truth for uncommitted
# brand assets — logos, licensed fonts, and per-client theme config. The build
# tools can't read from it directly:
#
#   - Astro serves web fonts only from packages/web/public/
#   - Docker COPY can't reach outside the infra/weasyprint/ build context
#
# so fonts are copied into both. Those destinations are gitignored too, which
# keeps licensed binaries out of the public repo no matter which path is used.
#
# This is a mirror, not an add-only copy: a font removed or renamed under
# brand/ is removed from both destinations, and a client directory that no
# longer exists under brand/ is deleted outright. Nothing else may write to
# those two directories — a hand-placed file there will be pruned on the next
# run. (That is also why deploy.sh protects them from its own --delete: the
# authoritative deletion happens here, against brand/, not against whatever
# working tree happens to be deploying.)
#
# Symlinking instead of copying does not work: `rsync -a` preserves symlinks,
# so the deploy host would receive dangling links, and Docker will not follow
# a symlink out of its build context.
#
# Layout expected under brand/:
#   brand/<client>/fonts/*.{woff2,woff,otf,ttf}   font files
#   brand/<client>/logo.{svg,png}                 logo source and upload copy
#   brand/<client>/theme.json                     theme tokens
#
# Web fonts are served at /fonts/<client>/<file>, which is what a theme's
# `fonts.custom[].src` must point at. Extensions are lowercased on the way in
# so that URL has exactly one valid spelling (see packages/web/src/lib/theme.ts).
#
# Usage:
#   ./scripts/sync-brand-assets.sh
#
# Safe to re-run; run it after adding fonts and before `deploy.sh`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRAND_DIR="$ROOT/brand"
WEB_FONTS="$ROOT/packages/web/public/fonts"
PRINT_FONTS="$ROOT/infra/weasyprint/fonts"

if [[ ! -d "$BRAND_DIR" ]]; then
  echo "No brand/ directory — nothing to sync."
  echo "Create brand/<client>/fonts/ and re-run. See user-docs/themes.md."
  exit 0
fi

mkdir -p "$WEB_FONTS" "$PRINT_FONTS"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Stage a normalised copy of every client's fonts, then mirror the staging
# tree into both destinations. Staging is what makes pruning safe: the mirror
# is computed once, from brand/, rather than by deleting in place.
synced=0
clients=()
shopt -s nullglob nocaseglob

for client_dir in "$BRAND_DIR"/*/; do
  [[ -d "$client_dir" ]] || continue
  client="$(basename "$client_dir")"
  fonts_dir="$client_dir/fonts"

  if [[ ! -d "$fonts_dir" ]]; then
    echo "  $client: no fonts/ directory, skipping"
    continue
  fi

  # nocaseglob is set, so this also picks up FONT.OTF / Font.Woff2.
  files=("$fonts_dir"/*.woff2 "$fonts_dir"/*.woff "$fonts_dir"/*.otf "$fonts_dir"/*.ttf)

  if [[ ${#files[@]} -eq 0 ]]; then
    echo "  $client: no font files, skipping"
    continue
  fi

  mkdir -p "$STAGE/$client"
  for f in "${files[@]}"; do
    name="$(basename "$f")"
    base="${name%.*}"
    ext="$(echo "${name##*.}" | tr '[:upper:]' '[:lower:]')"
    dest="$STAGE/$client/$base.$ext"
    if [[ -e "$dest" ]]; then
      echo "ERROR: $client: '$name' collides with an already-staged file at" >&2
      echo "       $base.$ext — two sources differ only by extension case." >&2
      exit 1
    fi
    cp -p "$f" "$dest"
  done

  clients+=("$client")
  echo "  $client: ${#files[@]} font file(s)"
  synced=$((synced + ${#files[@]}))
done

shopt -u nullglob nocaseglob

# Both destinations are namespaced per client. Web needs it so /fonts/<client>/
# stays unambiguous; print needs it because two clients shipping the same
# filename (Regular.woff2 is not a rare name) would otherwise overwrite each
# other. fontconfig scans recursively, so the nesting costs nothing there —
# the built-in families in the Dockerfile already sit in per-family directories.
if [[ ${#clients[@]} -eq 0 ]]; then
  # Mirror semantics would say "no sources, empty the destinations", but an
  # empty brand/ is far more often a half-finished setup than a deliberate
  # removal of every font. Refuse to be the thing that silently unbrands the
  # site; deleting the destinations by hand stays available.
  echo
  echo "No fonts found under brand/ — leaving existing font directories alone."
  echo "Remove them by hand if that is really what you want:"
  echo "  rm -rf $WEB_FONTS/* $PRINT_FONTS/*"
  exit 0
fi

for dest in "$WEB_FONTS" "$PRINT_FONTS"; do
  # --delete prunes fonts removed or renamed under brand/, and client
  # directories that no longer exist there at all. .gitkeep is excluded so it
  # survives: it is tracked, and the image's `COPY fonts/` needs the directory
  # to exist on a fresh clone.
  rsync -a --delete --exclude=.gitkeep "$STAGE/" "$dest/"
done

echo
echo "Synced $synced font file(s) across ${#clients[@]} client(s)."
echo "  web:   $WEB_FONTS/<client>/"
echo "  print: $PRINT_FONTS/<client>/"
echo
echo "PDF fonts are baked into the WeasyPrint image — rebuild it to pick up"
echo "changes:  DEPLOY_HOST=... ./scripts/deploy.sh --infra"
