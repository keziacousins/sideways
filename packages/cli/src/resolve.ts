/**
 * Path-first resolution for the CLI.
 *
 * `.sideways.yml` declares which sections this repo owns and where they
 * mount on disk. Every command takes a user argument — a path or a slug —
 * and resolves it to a `(sectionSlug, path)` pair that uniquely identifies
 * a document on the server.
 *
 * Resolution rules (see PROPOSAL-path-formalisation.md):
 *
 *   1. Treat the argument as a path; resolve to absolute; normalise.
 *   2. Find which declared section mount contains the path.
 *   3. Strip the mount prefix → that's the candidate `documents.path`.
 *   4. Out-of-mount paths error (unless caller opts into slug fallback).
 *
 * Slug fallback is allowed for `pull` (the one command where you may not
 * have a local file yet). Other commands must resolve via path.
 */

import { existsSync } from "node:fs";
import { resolve, relative, isAbsolute, sep } from "node:path";
import type { ProjectConfig } from "./config.js";
import { slugFromFilename } from "./sync.js";

/** A successful resolution result. */
export interface Resolved {
  /** The section this doc belongs to. */
  sectionSlug: string;
  /** The local mount root for that section (absolute). */
  mountDir: string;
  /** Path within the section, normalised with forward slashes. */
  path: string;
  /** Absolute filesystem path. */
  absPath: string;
  /** Filesystem path relative to the repo root. */
  relPath: string;
}

/** An (owned, on-disk) section mount. */
export interface Mount {
  sectionSlug: string;
  /** Absolute path of the mount root. */
  dir: string;
  /** Path of the mount relative to rootDir (no trailing slash). */
  relDir: string;
}

/** Build the list of section mounts declared in config, sorted by relDir length
 *  descending so longest-prefix matching is unambiguous. */
export function mounts(config: ProjectConfig): Mount[] {
  const list: Mount[] = [];
  for (const [slug, local] of Object.entries(config.sections)) {
    const abs = resolve(config.rootDir, local);
    list.push({
      sectionSlug: slug,
      dir: abs,
      relDir: normalise(relative(config.rootDir, abs)),
    });
  }
  list.sort((a, b) => b.relDir.length - a.relDir.length);
  return list;
}

/** Find the mount whose directory contains the given absolute path, if any. */
export function mountForPath(mounts: Mount[], absPath: string): Mount | null {
  for (const m of mounts) {
    if (absPath === m.dir) return m;
    if (absPath.startsWith(m.dir + sep)) return m;
  }
  return null;
}

/**
 * Resolve a user-provided argument to a (sectionSlug, path) pair.
 *
 * Behaviour:
 *   - Arg is treated as a filesystem path, resolved against cwd.
 *   - Must fall under one of the declared section mounts → 1 candidate.
 *   - Out-of-mount paths return `null` (caller can decide to error or hint).
 */
export function resolveArg(
  config: ProjectConfig,
  arg: string,
  cwd: string = process.cwd(),
): Resolved | null {
  const absPath = isAbsolute(arg) ? resolve(arg) : resolve(cwd, arg);
  const list = mounts(config);
  const mount = mountForPath(list, absPath);
  if (!mount) return null;

  const inMount = relative(mount.dir, absPath);
  return {
    sectionSlug: mount.sectionSlug,
    mountDir: mount.dir,
    path: normalise(inMount),
    absPath,
    relPath: normalise(relative(config.rootDir, absPath)),
  };
}

/**
 * Suggest the closest tracked path for an argument that didn't resolve.
 * Used by callers to emit "did you mean?" hints.
 *
 * Heuristic: derive a slug from the argument's basename and look for a
 * file with that slug in any owned mount. Returns an array of matches.
 */
export function suggestPaths(
  config: ProjectConfig,
  arg: string,
): Array<{ sectionSlug: string; path: string }> {
  // Cheap heuristic over the on-disk tree of each mount.
  // For a richer suggestion (using server state), callers can pass in the
  // sync cache or hit the API; that's out of scope for the offline helper.
  const wanted = slugFromFilename(arg.split("/").pop() ?? arg);
  const hits: Array<{ sectionSlug: string; path: string }> = [];

  for (const m of mounts(config)) {
    if (!existsSync(m.dir)) continue;
    walkForSlug(m.dir, m.dir, wanted, (rel) => {
      hits.push({ sectionSlug: m.sectionSlug, path: normalise(rel) });
    });
  }
  return hits;
}

function walkForSlug(
  root: string,
  dir: string,
  wantedSlug: string,
  emit: (rel: string) => void,
): void {
  let entries: string[];
  try {
    entries = require("node:fs").readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const full = resolve(dir, entry);
    let stat;
    try {
      stat = require("node:fs").statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkForSlug(root, full, wantedSlug, emit);
    } else if (entry.endsWith(".md") && slugFromFilename(entry) === wantedSlug) {
      emit(relative(root, full));
    }
  }
}

/** POSIX-style path. */
export function normalise(p: string): string {
  return p.split(sep).join("/");
}
