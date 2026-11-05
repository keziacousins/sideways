#!/bin/sh
# Install one consumer's fonts from fonts.lock into a directory.
#
#   fetch-fonts.sh <consumer> <dest-dir>      e.g.  fetch-fonts.sh print /usr/share/fonts/sideways
#
# Each download is fetched once, checked against its pinned SHA-256, and then
# either copied into place or has the named member extracted from it. Any
# mismatch fails the run (and so the image build): a changed upstream artefact
# must never reach a render.
#
# POSIX sh, so the same script runs in the WeasyPrint image (Debian, wget) and
# the Typst image (Debian, wget), and on a developer's Mac (curl, shasum) for
# running the Typst sidecar outside Docker. Needs unzip for the zip entries.
#
# Brand fonts are not here: they are licensed, live in the gitignored brand/
# tree, and reach the images through infra/fonts/brand/ (see
# scripts/sync-brand-assets.sh).

set -eu

consumer=${1:?usage: fetch-fonts.sh <consumer> <dest-dir>}
dest=${2:?usage: fetch-fonts.sh <consumer> <dest-dir>}
here=$(cd "$(dirname "$0")" && pwd)
lock="$here/fonts.lock"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

download() { # url file
  if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$2" "$1"
  else wget -q -O "$2" "$1"; fi
}

sha256() { # file
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

grep -v '^[[:space:]]*#' "$lock" | grep -v '^[[:space:]]*$' | while read -r who path sum url member; do
  [ "$who" = "$consumer" ] || continue

  # One download per checksum, however many files come out of it.
  blob="$work/$sum"
  if [ ! -f "$blob" ]; then
    download "$url" "$blob.part"
    actual=$(sha256 "$blob.part")
    if [ "$actual" != "$sum" ]; then
      echo "fetch-fonts: $url: sha256 $actual does not match pinned $sum" >&2
      exit 1
    fi
    mv "$blob.part" "$blob"
  fi

  mkdir -p "$dest/$(dirname "$path")"
  if [ -n "${member:-}" ]; then
    unzip -p "$blob" "$member" > "$dest/$path"
    [ -s "$dest/$path" ] || { echo "fetch-fonts: $member not found in $url" >&2; exit 1; }
  else
    cp "$blob" "$dest/$path"
  fi
  echo "  $consumer: $path"
done
