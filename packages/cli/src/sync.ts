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
 * Compare local and remote state to determine sync status for each file.
 */
export type FileStatus = "unchanged" | "modified" | "new" | "deleted" | "conflict";

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
      diffs.push({ filename, slug, status: "new" });
    } else if (!tracked && remote) {
      // File exists locally and remotely but never synced — treat as modified
      diffs.push({ filename, slug, status: "modified" });
    } else if (tracked) {
      if (!remote) {
        // Tracked locally but not on remote — needs push
        diffs.push({ filename, slug, status: "new" });
      } else {
        const localChanged = localHash !== tracked.localHash;
        const remoteChanged = remote.contentHash !== tracked.remoteHash;

        if (localChanged && remoteChanged) {
          diffs.push({ filename, slug, status: "conflict" });
        } else if (localChanged) {
          diffs.push({ filename, slug, status: "modified" });
        } else if (remoteChanged) {
          diffs.push({ filename, slug, status: "modified" });
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
        diffs.push({ filename, slug: remote.slug, status: "new" });
      }
    }
  }

  return diffs;
}
