/**
 * Sync metadata — tracks local ↔ remote state for change detection.
 * Stored in .sideways/sync.json alongside synced markdown files.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { extractComments } from "@sideways/markdown";

export interface SyncFileEntry {
  slug: string;
  remoteVersion: number;
  localHash: string;
  remoteHash: string;
}

export interface SyncState {
  space: string;
  section: string | null;
  lastSync: string;
  files: Record<string, SyncFileEntry>;
}

const SYNC_DIR = ".sideways";
const SYNC_FILE = "sync.json";
const TRACKED_FILE = "tracked.json";

/** Read the tracked files list. Returns null if no tracked.json exists (needs initial add). */
export function readTracked(dir: string): string[] | null {
  const trackPath = join(dir, SYNC_DIR, TRACKED_FILE);
  if (existsSync(trackPath)) {
    try {
      const data = JSON.parse(readFileSync(trackPath, "utf-8"));
      return Array.isArray(data) ? data : [];
    } catch {}
  }
  return null;
}

/** Check if tracking has been initialised (tracked.json exists). */
export function hasTracking(dir: string): boolean {
  return existsSync(join(dir, SYNC_DIR, TRACKED_FILE));
}

/** Write the tracked files list. */
export function writeTracked(dir: string, tracked: string[]): void {
  const syncDir = join(dir, SYNC_DIR);
  mkdirSync(syncDir, { recursive: true });
  writeFileSync(join(syncDir, TRACKED_FILE), JSON.stringify([...new Set(tracked)].sort(), null, 2));
}

/** Check if a relative path is tracked. Null or empty array = everything is tracked. */
export function isTracked(tracked: string[] | null, relativePath: string): boolean {
  if (!tracked || tracked.length === 0) return true;
  return tracked.some(pattern => {
    // Exact match
    if (relativePath === pattern) return true;
    // Directory match (pattern "docs/" or "docs" matches "docs/anything.md")
    const dir = pattern.endsWith("/") ? pattern : pattern + "/";
    if (relativePath.startsWith(dir)) return true;
    // Slug match (pattern without .md matches file)
    if (!pattern.includes("/") && !pattern.endsWith(".md")) {
      const slug = pattern.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const fileSlug = relativePath.replace(/\.md$/, "").split("/").pop()?.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      if (slug === fileSlug) return true;
    }
    return false;
  });
}

/** Hash file contents for change detection. Normalizes whitespace for stable comparison. */
export function hashContent(content: string): string {
  return createHash("sha256").update(content.trim()).digest("hex").slice(0, 16);
}

/** Extract canonical content from a file on disk (strip comments + frontmatter) and hash it */
export function hashLocalFile(fileContent: string): string {
  const { clean } = extractComments(fileContent);
  const { content } = parseFrontmatter(clean);
  return hashContent(content);
}

/** Read sync state for a directory, or return empty state.
 *  Returns empty state if the stored space doesn't match (stale config). */
export function readSyncState(dir: string, space: string, section: string | null = null): SyncState {
  const syncPath = join(dir, SYNC_DIR, SYNC_FILE);
  if (existsSync(syncPath)) {
    try {
      const state = JSON.parse(readFileSync(syncPath, "utf-8"));
      if (state.space === space) return state;
      // Space mismatch — stale sync state, start fresh
    } catch {}
  }
  return { space, section, lastSync: "", files: {} };
}

/** Write sync state to a directory */
export function writeSyncState(dir: string, state: SyncState): void {
  const syncDir = join(dir, SYNC_DIR);
  mkdirSync(syncDir, { recursive: true });
  writeFileSync(join(syncDir, SYNC_FILE), JSON.stringify(state, null, 2));
}

/** Derive a document slug from a filename */
export function slugFromFilename(filename: string): string {
  return filename
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

/** Derive a title from a slug */
export function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Parse YAML frontmatter from markdown content.
 * Returns { frontmatter, content } where content has frontmatter stripped.
 */
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
      // Parse arrays like [tag1, tag2]
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

/**
 * Serialize frontmatter + content back to markdown.
 */
export function serializeFrontmatter(
  frontmatter: Record<string, any>,
  content: string,
): string {
  const entries = Object.entries(frontmatter).filter(
    ([, v]) => v !== undefined && v !== null,
  );
  if (entries.length === 0) return content;

  const lines = entries.map(([key, value]) => {
    if (Array.isArray(value)) {
      return `${key}: [${value.join(", ")}]`;
    }
    return `${key}: ${value}`;
  });

  return `---\n${lines.join("\n")}\n---\n${content}`;
}

/**
 * Find all .md files in a directory (non-recursive).
 */
export function findMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && statSync(join(dir, f)).isFile())
    .sort();
}

/**
 * Recursively find all .md files, returning relative paths from the root dir.
 * Also maps directory structure to section/parent relationships.
 *
 * Convention:
 * - First-level subdirectories = sections
 * - Deeper directories = doc nesting (parent is index.md or directory name)
 * - index.md in a directory = the parent page for that directory's other files
 */
export interface DiscoveredFile {
  /** Relative path from sync root, e.g. "getting-started/installation.md" */
  relativePath: string;
  /** Filename only, e.g. "installation.md" */
  filename: string;
  /** Document slug derived from filename */
  slug: string;
  /** Section slug (first-level directory) or null for root files */
  section: string | null;
  /** Parent doc slug (from parent directory's index.md or dir name) or null */
  parentSlug: string | null;
  /** Nesting depth: 0 = root, 1 = in section, 2+ = nested under parent */
  depth: number;
}

const DEFAULT_IGNORE = [
  "node_modules", "venv", ".venv", "__pycache__", ".git",
  "dist", "build", ".next", ".nuxt", ".output",
  "vendor", "target", ".tox", "env",
];

function shouldIgnore(name: string, extraIgnore: string[] = []): boolean {
  if (name.startsWith(".")) return true;
  const all = [...DEFAULT_IGNORE, ...extraIgnore];
  return all.includes(name);
}

export function discoverFiles(rootDir: string, ignore: string[] = []): DiscoveredFile[] {
  const results: DiscoveredFile[] = [];

  function walk(dir: string, relPath: string, depth: number, section: string | null, parentSlug: string | null) {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir).sort();
    const dirSlug = relPath ? slugFromFilename(relPath.split("/").pop()!) : null;

    // index.md in a directory = the page for that directory
    // It becomes the parent for all other files in this directory
    const hasIndex = entries.includes("index.md") && statSync(join(dir, "index.md")).isFile();
    let effectiveParent = parentSlug;

    if (hasIndex && depth >= 1) {
      const indexSlug = dirSlug || slugFromFilename("index");
      results.push({
        relativePath: relPath ? `${relPath}/index.md` : "index.md",
        filename: "index.md",
        slug: indexSlug,
        section: depth === 1 ? dirSlug : section,
        parentSlug: parentSlug,
        depth,
      });
      effectiveParent = indexSlug;
    }

    // Process .md files (except index.md)
    for (const entry of entries) {
      if (entry === "index.md") continue;
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isFile() && entry.endsWith(".md")) {
        const fileSlug = slugFromFilename(entry);
        results.push({
          relativePath: relPath ? `${relPath}/${entry}` : entry,
          filename: entry,
          slug: fileSlug,
          section: depth >= 1 ? (section || dirSlug) : null,
          parentSlug: hasIndex ? effectiveParent : parentSlug,
          depth,
        });
      }
    }

    // Recurse into subdirectories
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      if (shouldIgnore(entry, ignore)) continue;
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        const childRel = relPath ? `${relPath}/${entry}` : entry;
        const childSection = depth === 0 ? slugFromFilename(entry) : section;
        // Parent for files in subdirectory = this directory's index.md (if it exists)
        const childParent = hasIndex ? effectiveParent : parentSlug;
        walk(fullPath, childRel, depth + 1, childSection, childParent);
      }
    }
  }

  walk(rootDir, "", 0, null, null);
  return results;
}

/**
 * Compare local and remote state to determine sync status for each file.
 */
export type FileStatus = "unchanged" | "local-modified" | "remote-modified" | "new-local" | "new-remote" | "deleted" | "conflict";

export interface SyncDiff {
  filename: string;
  slug: string;
  status: FileStatus;
}

export function computeDiff(
  dir: string,
  syncState: SyncState,
  remoteFiles: { slug: string; contentHash: string; version: number }[],
): SyncDiff[] {
  const diffs: SyncDiff[] = [];
  const localFiles = findMarkdownFiles(dir);
  const remoteMap = new Map(remoteFiles.map((f) => [f.slug, f]));
  const seenSlugs = new Set<string>();

  // Check each local file
  for (const filename of localFiles) {
    const slug = slugFromFilename(filename);
    seenSlugs.add(slug);
    const raw = readFileSync(join(dir, filename), "utf-8");
    const localHash = hashLocalFile(raw);
    const tracked = syncState.files[filename];
    const remote = remoteMap.get(slug);

    if (!tracked && !remote) {
      // New local file, not on remote
      diffs.push({ filename, slug, status: "new-local" });
    } else if (!tracked && remote) {
      // File exists locally and remotely but never synced
      diffs.push({ filename, slug, status: "conflict" });
    } else if (tracked) {
      if (!remote) {
        // Tracked locally but not on remote — needs push
        diffs.push({ filename, slug, status: "new-local" });
      } else {
        const localChanged = localHash !== tracked.localHash;
        const remoteChanged = remote.contentHash !== tracked.remoteHash;

        if (localChanged && remoteChanged) {
          diffs.push({ filename, slug, status: "conflict" });
        } else if (localChanged) {
          diffs.push({ filename, slug, status: "local-modified" });
        } else if (remoteChanged) {
          diffs.push({ filename, slug, status: "remote-modified" });
        } else {
          diffs.push({ filename, slug, status: "unchanged" });
        }
      }
    }
  }

  // Check for remote files not present locally
  for (const remote of remoteFiles) {
    if (!seenSlugs.has(remote.slug)) {
      const filename = `${remote.slug}.md`;
      const tracked = syncState.files[filename];
      if (tracked) {
        // Was tracked but file deleted locally
        diffs.push({ filename, slug: remote.slug, status: "deleted" });
      } else {
        // New remote file
        diffs.push({ filename, slug: remote.slug, status: "new-remote" });
      }
    }
  }

  return diffs;
}
