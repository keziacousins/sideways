/**
 * Hosted assets — the images and PDFs that documents reference.
 *
 * Documents are discovered by walking the mounts; assets are not. An asset
 * is in scope because a tracked document references it with a relative link
 * (`![flow](./img/flow.png)`), which keeps `push` from sweeping up every
 * stray binary that happens to sit in a docs directory. In the other
 * direction, `pull` takes whatever assets the server holds for a section
 * this repo owns.
 *
 * Change detection is simpler than for documents: the server's hash of an
 * asset is the SHA-256 of its bytes, so a local file and a remote asset can
 * be compared directly. The sync cache keeps the one hash both sides agreed
 * on at the last reconcile, which is what tells "I changed it" from "it
 * changed on the server" when they differ.
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { extractAssetRefs, extractComments } from "@sideways/markdown";
import type { createClient, AssetInfo } from "./api.js";
import type { Mount } from "./resolve.js";
import { syncKey, parseFrontmatter, type DiscoveredFile, type SyncState } from "./sync.js";

export type AssetStatus =
  | "unchanged"
  | "new-local"
  | "local-modified"
  | "remote-modified"
  | "new-remote"
  /** Synced once, since removed from disk. Left alone: not re-pulled, not deleted remotely. */
  | "deleted-local"
  | "conflict";

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Classify one asset from the three hashes that describe it: what is on
 * disk, what the server has, and what both had at the last reconcile.
 *
 * With no reconcile on record and the two sides differing, modification
 * times decide the direction — the same fallback documents use.
 */
export function classifyAsset(a: {
  localHash: string | null;
  remoteHash: string | null;
  syncedHash?: string;
  localMtime?: number;
  remoteMtime?: number;
}): AssetStatus {
  const { localHash, remoteHash, syncedHash } = a;

  if (localHash === null) {
    if (remoteHash === null) return "unchanged";
    return syncedHash === undefined ? "new-remote" : "deleted-local";
  }
  if (remoteHash === null) return "new-local";
  if (localHash === remoteHash) return "unchanged";

  if (syncedHash === undefined) {
    return (a.localMtime ?? 0) > (a.remoteMtime ?? 0) ? "local-modified" : "remote-modified";
  }
  if (localHash === syncedHash) return "remote-modified";
  if (remoteHash === syncedHash) return "local-modified";
  return "conflict";
}

/** One asset as seen from this repo: where it sits on disk, and what the server has. */
export interface AssetCandidate {
  sectionSlug: string;
  /** Path within the section (POSIX). */
  path: string;
  absPath: string;
  /** Path relative to the repo root (POSIX), for display. */
  relPath: string;
  /** Null when the file is not on disk. */
  localHash: string | null;
  /** Null when the server has no asset at this path. */
  remote: AssetInfo | null;
  status: AssetStatus;
}

export interface AssetSurvey {
  candidates: AssetCandidate[];
  /** References to files that exist neither on disk nor on the server. */
  missing: Array<{ docRelPath: string; relPath: string }>;
  /** False when the server predates hosted assets. */
  supported: boolean;
}

type DocFile = Pick<DiscoveredFile, "sectionSlug" | "path" | "absPath" | "relPath">;

const POSIX = (p: string) => p.split(sep).join("/");

function readIfFile(absPath: string): { hash: string; mtime: number } | null {
  try {
    const stat = statSync(absPath);
    if (!stat.isFile()) return null;
    return { hash: hashBytes(readFileSync(absPath)), mtime: stat.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Work out which assets are in play and where each one stands.
 *
 * `files` are the documents whose references define the local side.
 * `includeRemote` adds every asset the server holds in a section this repo
 * owns, referenced locally or not — what `pull` wants.
 */
export async function surveyAssets(opts: {
  client: ReturnType<typeof createClient>;
  space: string;
  rootDir: string;
  mounts: Mount[];
  syncState: SyncState;
  files: DocFile[];
  includeRemote: boolean;
}): Promise<AssetSurvey> {
  const { rootDir, mounts, syncState } = opts;
  const mountFor = new Map(mounts.map((m) => [m.sectionSlug, m]));

  const remoteList = await opts.client.listAssets(opts.space);
  const remoteMap = new Map(
    (remoteList ?? []).map((r) => [syncKey(r.sectionSlug, r.path), r]),
  );

  const candidates = new Map<string, AssetCandidate>();
  const missing: AssetSurvey["missing"] = [];

  /** Add the asset at `(sectionSlug, path)`; false if it exists on neither side. */
  const consider = (sectionSlug: string, path: string): boolean => {
    const key = syncKey(sectionSlug, path);
    if (candidates.has(key)) return true;
    const mount = mountFor.get(sectionSlug);
    if (!mount) return true; // Section not owned by this repo; not ours to judge.

    const absPath = join(mount.dir, ...path.split("/"));
    const local = readIfFile(absPath);
    const remote = remoteMap.get(key) ?? null;
    if (!local && !remote) return false;

    candidates.set(key, {
      sectionSlug,
      path,
      absPath,
      relPath: POSIX(relative(rootDir, absPath)),
      localHash: local?.hash ?? null,
      remote,
      status: classifyAsset({
        localHash: local?.hash ?? null,
        remoteHash: remote?.contentHash ?? null,
        syncedHash: syncState.assets?.[key]?.hash,
        localMtime: local?.mtime,
        remoteMtime: remote ? new Date(remote.updatedAt).getTime() : undefined,
      }),
    });
    return true;
  };

  for (const file of opts.files) {
    let raw: string;
    try {
      raw = readFileSync(file.absPath, "utf-8");
    } catch {
      continue;
    }
    // Same text the server gets: comments and frontmatter stripped.
    const { content } = parseFrontmatter(extractComments(raw).clean);
    for (const path of extractAssetRefs(content, file.path)) {
      if (!consider(file.sectionSlug, path)) {
        const mount = mountFor.get(file.sectionSlug)!;
        missing.push({
          docRelPath: file.relPath,
          relPath: POSIX(relative(rootDir, join(mount.dir, ...path.split("/")))),
        });
      }
    }
  }

  if (opts.includeRemote) {
    for (const r of remoteMap.values()) consider(r.sectionSlug, r.path);
  }

  return {
    candidates: [...candidates.values()].sort((a, b) => a.relPath.localeCompare(b.relPath)),
    missing,
    supported: remoteList !== null,
  };
}

export interface AssetPlan {
  uploads: AssetCandidate[];
  downloads: AssetCandidate[];
  conflicts: AssetCandidate[];
  /** In agreement already; only the sync cache needs to hear about it. */
  settled: AssetCandidate[];
}

/**
 * Decide what to do with each surveyed asset. `push` and `pull` say which
 * directions the command moves bytes in; `force` resolves a conflict in
 * favour of one of them.
 */
export function planAssets(
  survey: AssetSurvey,
  opts: { push: boolean; pull: boolean; force?: "push" | "pull" },
): AssetPlan {
  const plan: AssetPlan = { uploads: [], downloads: [], conflicts: [], settled: [] };
  if (!survey.supported) return plan;

  for (const c of survey.candidates) {
    switch (c.status) {
      case "unchanged":
        if (c.localHash !== null) plan.settled.push(c);
        break;
      case "new-local":
      case "local-modified":
        if (opts.push) plan.uploads.push(c);
        break;
      case "new-remote":
      case "remote-modified":
        if (opts.pull) plan.downloads.push(c);
        break;
      case "deleted-local":
        if (opts.pull && opts.force === "pull") plan.downloads.push(c);
        break;
      case "conflict":
        if (opts.push && opts.force === "push") plan.uploads.push(c);
        else if (opts.pull && opts.force === "pull") plan.downloads.push(c);
        else plan.conflicts.push(c);
        break;
    }
  }
  return plan;
}

/**
 * Carry out a plan, recording each reconciled asset in `syncState` (the
 * caller writes it to disk). A failed asset is reported and skipped; it
 * never aborts the rest.
 */
export async function runAssetPlan(
  plan: AssetPlan,
  opts: {
    client: ReturnType<typeof createClient>;
    space: string;
    syncState: SyncState;
    dryRun?: boolean;
  },
): Promise<{ pushed: number; pulled: number; failed: number }> {
  const { client, space, syncState } = opts;
  const result = { pushed: 0, pulled: 0, failed: 0 };

  const record = (c: AssetCandidate, hash: string) => {
    syncState.assets ??= {};
    syncState.assets[syncKey(c.sectionSlug, c.path)] = {
      sectionSlug: c.sectionSlug,
      path: c.path,
      hash,
    };
  };

  if (!opts.dryRun) {
    for (const c of plan.settled) record(c, c.localHash!);
  }

  for (const c of plan.uploads) {
    const target = `${c.sectionSlug}/${c.path}`;
    if (opts.dryRun) {
      console.log(`  would push: ${c.relPath} → ${target} (${c.status})`);
      result.pushed++;
      continue;
    }
    try {
      const uploaded = await client.putAsset(space, c.sectionSlug, c.path, readFileSync(c.absPath));
      record(c, uploaded.contentHash);
      console.log(`  pushed: ${c.relPath} → ${target} (${c.status})`);
      result.pushed++;
    } catch (e: any) {
      console.log(`  failed: ${c.relPath} — ${e.message}`);
      result.failed++;
    }
  }

  for (const c of plan.downloads) {
    if (opts.dryRun) {
      console.log(`  would pull: ${c.relPath}`);
      result.pulled++;
      continue;
    }
    try {
      const bytes = await client.getAsset(space, c.sectionSlug, c.path);
      mkdirSync(dirname(c.absPath), { recursive: true });
      writeFileSync(c.absPath, bytes);
      record(c, hashBytes(bytes));
      console.log(`  pulled: ${c.relPath}`);
      result.pulled++;
    } catch (e: any) {
      console.log(`  failed: ${c.relPath} — ${e.message}`);
      result.failed++;
    }
  }

  return result;
}
