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
import { isDeepStrictEqual } from "node:util";
import { extractComments } from "@sideways/markdown";
import { frontmatterHashInput, type Frontmatter } from "@sideways/types";
import {
  Document as YamlDocument,
  isCollection,
  isMap,
  parse as parseYaml,
  parseDocument,
  type YAMLMap,
} from "yaml";
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

/** A hosted asset (image, PDF) in the local sync cache. */
export interface SyncAssetEntry {
  sectionSlug: string;
  /** Asset path within its section (POSIX-style). */
  path: string;
  /** SHA-256 of the bytes that local and remote agreed on at last reconcile. */
  hash: string;
}

export interface SyncState {
  /** Space slug — sanity-check against config to detect stale cache. */
  space: string;
  /** ISO timestamp of the last sync run. */
  lastSync: string;
  /** Cache entries keyed by "<sectionSlug>:<path>" for fast lookup. */
  files: Record<string, SyncFileEntry>;
  /** Hosted assets, keyed the same way. Absent in caches written before 1.8. */
  assets?: Record<string, SyncAssetEntry>;
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

/**
 * Find the discovered files an `add` argument can refer to. An exact relPath
 * match always wins. A bare name (no directory part) falls back to matching
 * by filename or slug, which can return several candidates; the caller treats
 * more than one as ambiguous. A path with a directory part never falls back,
 * so `vendors/idee/README.md` can't resolve to a root `README.md`.
 */
export function matchAddArg(files: DiscoveredFile[], rel: string, arg: string): DiscoveredFile[] {
  const exact = files.find(f => f.relPath === rel);
  if (exact) return [exact];
  if (arg.includes("/")) return [];
  const slug = slugFromFilename(arg);
  return files.filter(f => f.filename === arg || f.slug === slug);
}

/**
 * Hash a file the way the server hashes a version: content and frontmatter
 * together, so an edit to either counts as a change. Title and tags aren't
 * part of it.
 */
export function hashLocalFile(fileContent: string): string {
  const { clean } = extractComments(fileContent);
  const { content, frontmatter } = parseFrontmatter(clean);
  return createHash("sha256")
    .update(content.trim() + frontmatterHashInput(frontmatter))
    .digest("hex")
    .slice(0, 16);
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

export interface ParsedFile {
  /** Title and tags, which the server keeps as fields of their own. */
  title?: string;
  tags: string[];
  /** Every other frontmatter key. */
  frontmatter: Frontmatter;
  /** The markdown after the frontmatter block. */
  content: string;
  /** Why the frontmatter couldn't be read, when it couldn't. */
  error?: string;
}

const FRONTMATTER_BLOCK = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

/** Split a markdown file into its YAML frontmatter and content. */
export function parseFrontmatter(markdown: string): ParsedFile {
  const match = markdown.match(FRONTMATTER_BLOCK);
  if (!match) return { tags: [], frontmatter: {}, content: markdown };
  const content = match[2];

  let data: unknown;
  try {
    data = parseYaml(match[1]) ?? {};
  } catch (e) {
    return { tags: [], frontmatter: {}, content, error: (e as Error).message };
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    return { tags: [], frontmatter: {}, content, error: "frontmatter is not a set of keys" };
  }

  const { title, tags, ...rest } = data as Record<string, unknown>;
  return {
    title: title == null ? undefined : String(title),
    tags: tags == null ? [] : (Array.isArray(tags) ? tags : [tags]).map(String),
    // Through JSON, as the server will store it.
    frontmatter: JSON.parse(JSON.stringify(rest)),
    content,
  };
}

/**
 * Assemble a pulled document for disk. Title, tags and frontmatter come from
 * the server and are applied to the frontmatter of the file already there,
 * if any, so its comments, key order and quoting survive wherever the values
 * haven't changed.
 *
 * The server's frontmatter is null when no client has sent it any: then the
 * local keys are left as they are rather than taken for deleted. A local block
 * that isn't valid YAML is kept as it is, with a warning, rather than lost.
 *
 * The title is written when it differs from the document's H1, or when the
 * local file already had one.
 */
export function fileForDisk(
  doc: { title?: string | null; tags?: string[] | null; frontmatter?: Frontmatter | null },
  content: string,
  localRaw?: string | null,
): { text: string; warning?: string } {
  const localBlock = localRaw
    ? extractComments(localRaw).clean.match(FRONTMATTER_BLOCK)?.[1]
    : undefined;

  let yaml = new YamlDocument({});
  if (localBlock !== undefined) {
    const local = parseDocument(localBlock);
    if (local.errors.length > 0 || (local.contents !== null && !isMap(local.contents))) {
      return {
        text: `---\n${localBlock}\n---\n${content}`,
        warning: "its frontmatter isn't valid YAML, so it was kept as it was: fix it and pull again",
      };
    }
    if (isMap(local.contents)) yaml = local;
  }
  const map = yaml.contents as YAMLMap;

  const set = (key: string, value: unknown, first = false) => {
    if (yaml.has(key)) {
      if (isDeepStrictEqual(yaml.toJS()[key], value)) return;
      // A changed list or map keeps the style it was written in.
      const node = yaml.createNode(value);
      const old = yaml.get(key, true);
      if (isCollection(old) && isCollection(node)) node.flow = old.flow;
      yaml.set(key, node);
    } else if (first) {
      map.items.unshift(yaml.createPair(key, value));
    } else {
      yaml.set(key, value);
    }
  };

  const headingTitle = content.match(/^#\s+(.+)$/m)?.[1].trim() ?? null;
  if (doc.title && (doc.title !== headingTitle || yaml.has("title"))) {
    set("title", doc.title, true);
  } else {
    yaml.delete("title");
  }

  if (doc.frontmatter) {
    for (const key of Object.keys(yaml.toJS() ?? {})) {
      if (key !== "title" && key !== "tags" && !(key in doc.frontmatter)) yaml.delete(key);
    }
    for (const [key, value] of Object.entries(doc.frontmatter)) set(key, value);
  }

  if (doc.tags?.length) set("tags", doc.tags);
  else yaml.delete("tags");

  if (map.items.length === 0) return { text: content };
  return { text: `---\n${yaml.toString({ lineWidth: 0, flowCollectionPadding: false })}---\n${content}` };
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

/**
 * What `push` does with a file in each state. `--force` pushes every file,
 * matching `pull --force`: a file whose content hasn't moved can still carry
 * frontmatter (a title, tags) the server doesn't have, and a remote edit is
 * overwritten because keeping the local copy is what the flag asks for.
 */
export function pushAction(
  status: FileStatus,
  force: boolean,
): "push" | "skip" | "conflict" {
  if (force) return "push";
  if (status === "unchanged" || status === "remote-modified") return "skip";
  if (status === "conflict") return "conflict";
  return "push";
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
