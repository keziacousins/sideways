/**
 * Vendor the Typst packages listed in packages.json into ./vendor.
 *
 * The render workers run with no network (see sandboxEnv() in server.mjs), so
 * a diagram's `#import "@preview/cetz:0.4.2"` has to resolve from disk. Typst
 * looks for a package in its cache directory before trying to download it,
 * and that directory is `$XDG_CACHE_HOME/typst/packages` on Linux and
 * `$HOME/Library/Caches/typst/packages` on macOS. The workers get both
 * variables pointed in here, so this lays the tree out for both:
 *
 *   vendor/cache/typst/packages/<namespace>/<name>/<version>/…
 *   vendor/home/Library/Caches -> ../../cache
 *
 * Runs at `npm install` (postinstall) and again in the Docker build. Each
 * tarball is checked against its pinned SHA-256 before it is unpacked, so a
 * changed upstream artefact fails the build rather than shipping.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const vendor = process.env.TYPST_VENDOR_DIR || join(here, "vendor");
const { packages } = JSON.parse(readFileSync(join(here, "packages.json"), "utf8"));

const cacheRoot = join(vendor, "cache", "typst", "packages");

for (const pkg of packages) {
  const target = join(cacheRoot, pkg.namespace, pkg.name, pkg.version);
  if (existsSync(join(target, "typst.toml"))) continue;

  const url = `https://packages.typst.org/${pkg.namespace}/${pkg.name}-${pkg.version}.tar.gz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());

  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== pkg.sha256) {
    throw new Error(`${pkg.name}@${pkg.version}: sha256 ${digest} does not match pinned ${pkg.sha256}`);
  }

  // Unpack beside the target and only then move into place, so an interrupted
  // run never leaves a half-extracted package that the check above would skip.
  const staging = `${target}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const tarball = join(tmpdir(), `${pkg.name}-${pkg.version}-${process.pid}.tar.gz`);
  writeFileSync(tarball, bytes);
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", staging]);
  } finally {
    rmSync(tarball, { force: true });
  }
  rmSync(target, { recursive: true, force: true });
  execFileSync("mv", [staging, target]);
  console.log(`vendored ${pkg.namespace}/${pkg.name}@${pkg.version}`);
}

// macOS reads the cache from ~/Library/Caches; point it at the same tree.
const macCaches = join(vendor, "home", "Library", "Caches");
if (!existsSync(macCaches)) {
  mkdirSync(dirname(macCaches), { recursive: true });
  symlinkSync(join("..", "..", "cache"), macCaches);
}
// The data directory is where `@local` packages live. Give the workers an
// empty one so nothing from the host's own Typst install leaks in.
mkdirSync(join(vendor, "data"), { recursive: true });
