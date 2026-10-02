/**
 * Relative links between documents — `[setup](./intro.md)`.
 *
 * The server resolves these against the documents it holds, and marks one
 * unresolved when its target isn't there. That is the right thing for a
 * reader to see, but the author would rather hear about it before the push:
 * a link to a file that was never added, or that an ignore rule skips, looks
 * fine on disk and dead on Sideways.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractDocLinks, extractComments } from "@sideways/markdown";
import type { Mount } from "./resolve.js";
import { syncKey, parseFrontmatter, type DiscoveredFile } from "./sync.js";

export interface DocLinkGap {
  /** The linking document, relative to the repo root. */
  docRelPath: string;
  /** The link as written. */
  href: string;
  /**
   * - `missing`  — no file there at all.
   * - `unsynced` — the file exists, but isn't tracked (or is ignored), so
   *                the server will never have it.
   * - `outside`  — the link climbs above every section; no document on the
   *                server could be its target.
   */
  reason: "missing" | "unsynced" | "outside";
}

type DocFile = Pick<DiscoveredFile, "sectionSlug" | "path" | "absPath" | "relPath">;

/**
 * Find the relative `.md` links in `files` that will not resolve on the
 * server.
 *
 * `known` holds the sync key of every document that is, or is about to be,
 * on the server: the tracked local files plus whatever the server already
 * lists. A link whose target is in it is fine, wherever the target lives.
 */
export function findDocLinkGaps(opts: {
  files: DocFile[];
  known: Set<string>;
  mounts: Mount[];
}): DocLinkGap[] {
  const mountFor = new Map(opts.mounts.map((m) => [m.sectionSlug, m]));
  const gaps: DocLinkGap[] = [];

  for (const file of opts.files) {
    let raw: string;
    try {
      raw = readFileSync(file.absPath, "utf-8");
    } catch {
      continue;
    }
    // Same text the server gets: comments and frontmatter stripped.
    const { content } = parseFrontmatter(extractComments(raw).clean);

    for (const link of extractDocLinks(content, file.path)) {
      if (!link.ref) {
        gaps.push({ docRelPath: file.relPath, href: link.href, reason: "outside" });
        continue;
      }
      const sectionSlug = link.ref.sectionSlug ?? file.sectionSlug;
      if (opts.known.has(syncKey(sectionSlug, link.ref.path))) continue;

      const mount = mountFor.get(sectionSlug);
      const onDisk = mount !== undefined && existsSync(join(mount.dir, ...link.ref.path.split("/")));
      gaps.push({
        docRelPath: file.relPath,
        href: link.href,
        reason: onDisk ? "unsynced" : "missing",
      });
    }
  }

  return gaps;
}

const EXPLANATION: Record<DocLinkGap["reason"], string> = {
  missing: "which doesn't exist",
  unsynced: "which exists but isn't synced",
  outside: "which is outside every section",
};

export function reportDocLinkGaps(gaps: DocLinkGap[]): void {
  for (const gap of gaps) {
    console.warn(`warning: ${gap.docRelPath} links to ${gap.href}, ${EXPLANATION[gap.reason]}`);
  }
}
