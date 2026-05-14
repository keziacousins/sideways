/**
 * Sync state — local cache of what we last synced from the server.
 *
 * Under the path-and-sections model the server owns the canonical
 * `(sectionSlug, path)` identity of every doc; sync.json is purely a
 * change-detection cache. Each entry records the slug it resolves to plus
 * the local + remote content hashes from the last reconcile.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { extractComments } from "@sideways/markdown";
import type { Mount } from "./resolve.js";

/** A single tracked doc in the local sync cache. */
export interface SyncFileEntry {
  sectionSlug: string;
  /** Doc path within its section (POSIX-style). */
  path: string;
  /** Doc slug on the server (cached, not authoritative). */
  slug: string;
  /** Remote version we last reconciled against. */
  remoteVersion: number;
  /** Hash of the local file at last reconcile. */
  localHash: string;
  /** Server-reported content hash at last reconcile. */
  remoteHash: string;
}

export interface SyncState {
  /** Space slug — sanity-check against config to detect stale cache. */
  space: string;
  /** ISO timestamp of the last sync run. */
  lastSync: string;
  /** Cache entries keyed by "<sectionSlug>:<path>" for fast lookup. */
  files: Record<string, SyncFileEntry>;
  /** Schema version — bumped when the file shape changes. */
  schema: number;
}

const SYNC_DIR = ".sideways";
const SYNC_FILE = "sync.json";
const TRACKED_FILE = "tracked.json";
const CURRENT_SCHEMA = 2;

export function syncKey(sectionSlug: string, path: string): string {
  return `${sectionSlug}:${path}`;
}

/** Read the tracked-files list. Returns null if not initialised. */
export function readTracked(dir: string): string[] | null {
  const trackPath = join(dir, SYNC_DIR, TRACKED_FILE);
  if (!existsSync(trackPath)) return null;
  try {
    const data = JSON.parse(readFileSync(trackPath, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return null;
  }
}

export function hasTracking(dir: string): boolean {
  return existsSync(join(dir, SYNC_DIR, TRACKED_FILE));
}

export function writeTracked(dir: string, tracked: string[]): void {
  const syncDir = join(dir, SYNC_DIR);
  mkdirSync(syncDir, { recursive: true });
  writeFileSync(
    join(syncDir, TRACKED_FILE),
    JSON.stringify([...new Set(tracked)].sort(), null, 2),
  );
}

export function isTracked(tracked: string[] | null, relativePath: string): boolean {
  if (!tracked || tracked.length === 0) return true;
  return tracked.some(pattern => {
    if (relativePath === pattern) return true;
    const dir = pattern.endsWith("/") ? pattern : pattern + "/";
    if (relativePath.startsWith(dir)) return true;
    if (!pattern.includes("/") && !pattern.endsWith(".md")) {
      const slug = pattern.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const fileSlug = relativePath
        .replace(/\.md$/, "")
        .split("/")
        .pop()
        ?.toLowerCase()
        .replace(/[^a-z0-9-]/g, "-");
      if (slug === fileSlug) return true;
    }
    return false;
  });
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content.trim()).digest("hex").slice(0, 16);
}

export function hashLocalFile(fileContent: string): string {
  const { clean } = extractComments(fileContent);
  const { content } = parseFrontmatter(clean);
  return hashContent(content);
}

/**
 * Read the sync state for a repo root. Resets to an empty state if the
 * file is missing, malformed, from a different space, or from a previous
 * schema version (the path-and-sections refactor bumped to schema 2).
 */
export function readSyncState(dir: string, space: string): SyncState {
  const syncPath = join(dir, SYNC_DIR, SYNC_FILE);
  if (existsSync(syncPath)) {
    try {
      const state = JSON.parse(readFileSync(syncPath, "utf-8"));
      if (state.space === space && state.schema === CURRENT_SCHEMA) return state;
    } catch {}
  }
  return { space, lastSync: "", files: {}, schema: CURRENT_SCHEMA };
}

export function writeSyncState(dir: string, state: SyncState): void {
  const syncDir = join(dir, SYNC_DIR);
  mkdirSync(syncDir, { recursive: true });
  writeFileSync(
    join(syncDir, SYNC_FILE),
    JSON.stringify({ ...state, schema: CURRENT_SCHEMA }, null, 2),
  );
}

export function slugFromFilename(filename: string): string {
  return filename
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

export function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Parse YAML frontmatter from markdown. */
export function parseFrontmatter(
  markdown: string,
): { frontmatter: Record<string, any>; content: string } {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, content: markdown };

  const frontmatter: Record<string, any> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      let value: any = line.slice(colonIdx + 1).trim();
      if (value.startsWith("[") && value.endsWith("]")) {
        value = value
          .slice(1, -1)
          .split(",")
          .map((s: string) => s.trim());
      }
      frontmatter[key] = value;
    }
  }
  return { frontmatter, content: match[2] };
}

export function serializeFrontmatter(
  frontmatter: Record<string, any>,
  content: string,
): string {
  const entries = Object.entries(frontmatter).filter(
    ([, v]) => v !== undefined && v !== null,
  );
  if (entries.length === 0) return content;

  const lines = entries.map(([key, value]) => {
    if (Array.isArray(value)) return `${key}: [${value.join(", ")}]`;
    return `${key}: ${value}`;
  });
  return `---\n${lines.join("\n")}\n---\n${content}`;
}

export function findMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && statSync(join(dir, f)).isFile())
    .sort();
}

/**
 * A discovered local file, fully resolved against the configured mounts.
 *
 * Section comes from the owning mount; path is relative to that mount;
 * parentSlug is derived from `index.md` nesting (a directory's `index.md`
 * is the parent doc for its siblings, recursively).
 */
export interface DiscoveredFile {
  sectionSlug: string;
  /** Path within the section (POSIX). */
  path: string;
  /** Absolute filesystem path. */
  absPath: string;
  /** Path relative to repo rootDir (POSIX). For display + tracked filter. */
  relPath: string;
  /** Filename only. */
  filename: string;
  /** Slug derived from filename (or directory name for index.md). */
  slug: string;
  /** Parent slug if this file nests under a directory's index.md. */
  parentSlug: string | null;
}

const DEFAULT_IGNORE = [
  "node_modules", "venv", ".venv", "__pycache__", ".git",
  "dist", "build", ".next", ".nuxt", ".output",
  "vendor", "target", ".tox", "env",
];

function shouldIgnore(name: string, extra: string[] = []): boolean {
  if (name.startsWith(".")) return true;
  return [...DEFAULT_IGNORE, ...extra].includes(name);
}

const POSIX = (p: string) => p.split(sep).join("/");

/**
 * Walk every declared section mount and produce a flat list of all owned
 * markdown files. Section comes from the mount, not from directory naming.
 *
 * `index.md` semantics: a directory's `index.md` becomes a parent doc for
 * its siblings (and recursively for nested dirs). The mount root itself
 * may have an `index.md` whose slug defaults to the section slug.
 */
export function discoverFiles(
  rootDir: string,
  mounts: Mount[],
  ignore: string[] = [],
): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];

  for (const mount of mounts) {
    if (!existsSync(mount.dir)) continue;
    walkMount(mount, mount.dir, "", null, out, rootDir, ignore, /*atMountRoot=*/ true);
  }
  return out;
}

function walkMount(
  mount: Mount,
  dir: string,
  inMount: string,
  parentSlug: string | null,
  out: DiscoveredFile[],
  rootDir: string,
  ignore: string[],
  atMountRoot: boolean,
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }

  // index.md becomes the parent doc for its directory.
  const hasIndex =
    entries.includes("index.md") && statSync(join(dir, "index.md")).isFile();
  let effectiveParent = parentSlug;

  if (hasIndex) {
    const dirName = inMount ? inMount.split("/").pop()! : mount.sectionSlug;
    const indexSlug = slugFromFilename(dirName);
    const indexPath = inMount ? `${inMount}/index.md` : "index.md";
    const indexAbs = join(dir, "index.md");
    out.push({
      sectionSlug: mount.sectionSlug,
      path: indexPath,
      absPath: indexAbs,
      relPath: POSIX(relative(rootDir, indexAbs)),
      filename: "index.md",
      slug: indexSlug,
      parentSlug,
    });
    // Mount-root index.md doesn't get a parent of itself; nested ones do.
    if (!atMountRoot) effectiveParent = indexSlug;
    else effectiveParent = indexSlug; // also parents siblings at mount root
  }

  for (const entry of entries) {
    if (entry === "index.md") continue;
    if (!entry.endsWith(".md")) continue;
    const abs = join(dir, entry);
    if (!statSync(abs).isFile()) continue;
    const pathInMount = inMount ? `${inMount}/${entry}` : entry;
    out.push({
      sectionSlug: mount.sectionSlug,
      path: pathInMount,
      absPath: abs,
      relPath: POSIX(relative(rootDir, abs)),
      filename: entry,
      slug: slugFromFilename(entry),
      parentSlug: hasIndex ? effectiveParent : parentSlug,
    });
  }

  for (const entry of entries) {
    if (shouldIgnore(entry, ignore)) continue;
    const abs = join(dir, entry);
    try {
      if (!statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    const childInMount = inMount ? `${inMount}/${entry}` : entry;
    walkMount(
      mount,
      abs,
      childInMount,
      hasIndex ? effectiveParent : parentSlug,
      out,
      rootDir,
      ignore,
      false,
    );
  }
}

/**
 * Compute a per-section diff between the local sync cache, the on-disk
 * files in declared mounts, and the server's sync info.
 */
export type FileStatus =
  | "unchanged"
  | "local-modified"
  | "remote-modified"
  | "new-local"
  | "new-remote"
  | "deleted"
  | "conflict";

export interface SyncDiff {
  sectionSlug: string;
  path: string;
  slug: string;
  relPath: string;
  status: FileStatus;
}

export interface RemoteEntry {
  sectionSlug: string;
  path: string;
  slug: string;
  contentHash: string;
  version: number;
}

export function computeDiff(
  rootDir: string,
  mounts: Mount[],
  ignore: string[],
  syncState: SyncState,
  remote: RemoteEntry[],
): SyncDiff[] {
  const diffs: SyncDiff[] = [];
  const local = discoverFiles(rootDir, mounts, ignore);

  const localMap = new Map(local.map(f => [syncKey(f.sectionSlug, f.path), f]));
  const remoteMap = new Map(remote.map(r => [syncKey(r.sectionSlug, r.path), r]));
  const seen = new Set<string>();

  for (const [key, f] of localMap) {
    seen.add(key);
    const raw = readFileSync(f.absPath, "utf-8");
    const localHash = hashLocalFile(raw);
    const tracked = syncState.files[key];
    const r = remoteMap.get(key);

    if (!tracked && !r) {
      diffs.push({ ...common(f), status: "new-local" });
    } else if (!tracked && r) {
      diffs.push({ ...common(f), status: "conflict" });
    } else if (tracked) {
      if (!r) {
        diffs.push({ ...common(f), status: "new-local" });
      } else {
        const localChanged = localHash !== tracked.localHash;
        const remoteChanged = r.contentHash !== tracked.remoteHash;
        if (localChanged && remoteChanged) {
          diffs.push({ ...common(f), status: "conflict" });
        } else if (localChanged) {
          diffs.push({ ...common(f), status: "local-modified" });
        } else if (remoteChanged) {
          diffs.push({ ...common(f), status: "remote-modified" });
        } else {
          diffs.push({ ...common(f), status: "unchanged" });
        }
      }
    }
  }

  for (const [key, r] of remoteMap) {
    if (seen.has(key)) continue;
    const tracked = syncState.files[key];
    const mount = mounts.find(m => m.sectionSlug === r.sectionSlug);
    const relPath = mount
      ? POSIX(join(mount.relDir, r.path))
      : `${r.sectionSlug}/${r.path}`;
    if (tracked) {
      diffs.push({ sectionSlug: r.sectionSlug, path: r.path, slug: r.slug, relPath, status: "deleted" });
    } else {
      diffs.push({ sectionSlug: r.sectionSlug, path: r.path, slug: r.slug, relPath, status: "new-remote" });
    }
  }

  return diffs;
}

function common(f: DiscoveredFile) {
  return { sectionSlug: f.sectionSlug, path: f.path, slug: f.slug, relPath: f.relPath };
}
