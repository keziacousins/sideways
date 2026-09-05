#!/usr/bin/env bash
# Copy brand fonts out of `brand/` into the locations the builds read from.
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
# `fonts.custom[].src` must point at.
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

synced=0
for client_dir in "$BRAND_DIR"/*/; do
  [[ -d "$client_dir" ]] || continue
  client="$(basename "$client_dir")"
  fonts_dir="$client_dir/fonts"

  if [[ ! -d "$fonts_dir" ]]; then
    echo "  $client: no fonts/ directory, skipping"
    continue
  fi

  shopt -s nullglob
  files=("$fonts_dir"/*.woff2 "$fonts_dir"/*.woff "$fonts_dir"/*.otf "$fonts_dir"/*.ttf)
  shopt -u nullglob

  if [[ ${#files[@]} -eq 0 ]]; then
    echo "  $client: no font files, skipping"
    continue
  fi

  # Web: namespaced per client so /fonts/<client>/<file> stays unambiguous.
  mkdir -p "$WEB_FONTS/$client"
  cp -p "${files[@]}" "$WEB_FONTS/$client/"

  # WeasyPrint: flat, because fontconfig scans recursively and only cares
  # about the family names inside the files.
  cp -p "${files[@]}" "$PRINT_FONTS/"

  echo "  $client: ${#files[@]} font file(s)"
  synced=$((synced + ${#files[@]}))
done

echo
echo "Synced $synced font file(s)."
echo "  web:   $WEB_FONTS/<client>/"
echo "  print: $PRINT_FONTS/"
echo
echo "PDF fonts are baked into the WeasyPrint image — rebuild it to pick up"
echo "changes:  DEPLOY_HOST=... ./scripts/deploy.sh --infra"
