#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { basename, resolve, join, relative, dirname } from "node:path";
import { findConfig, createConfig, requireConfig, type ProjectConfig } from "./config.js";
import { createClient } from "./api.js";
import { login, clearCredentials, getStoredCredentials } from "./auth.js";
import { requireSpace, ensureSpace } from "./preflight.js";
import { embedComments, extractComments, type SerializedComment } from "@sideways/markdown";
import {
  readSyncState,
  writeSyncState,
  syncKey,
  hashLocalFile,
  slugFromFilename,
  parseFrontmatter,
  serializeFrontmatter,
  discoverFiles,
  type DiscoveredFile,
  readTracked,
  writeTracked,
  isTracked,
} from "./sync.js";
import {
  mounts as buildMounts,
  resolveArg,
  suggestPaths,
  normalise,
} from "./resolve.js";
import type { SyncInfo } from "./api.js";

const program = new Command();

const CLI_VERSION = process.env.SIDEWAYS_VERSION || "dev";

program
  .name("sideways")
  .description("Sideways CLI — push, pull, and manage documentation")
  .version(CLI_VERSION)
  .option("--as <name>", "Act as a named agent (e.g. --as Claude)");

// ── version (verbose) ────────────────────────────────────────────────
//
// `sideways --version` (commander's built-in) prints just the bundle
// version, no network. `sideways version` also prints the remote API's
// version from /health, and flags drift — catches the "I'm running a
// stale local CLI against a newer server" case.

program
  .command("version")
  .description("Show CLI version and the configured remote's API version")
  .action(async () => {
    console.log(`cli:     ${CLI_VERSION}`);
    const config = findConfig();
    if (!config) {
      console.log("remote:  (no .sideways.yml — run `sideways init` to configure)");
      return;
    }
    try {
      const res = await fetch(`${config.api}/health`);
      if (!res.ok) {
        console.log(`remote:  (${config.api} returned ${res.status})`);
        return;
      }
      const body = await res.json();
      const remoteVersion = body.version || "unknown";
      console.log(`remote:  ${remoteVersion} (${config.api})`);
      if (remoteVersion !== CLI_VERSION && CLI_VERSION !== "dev") {
        console.log(`\n⚠ Local CLI and remote API versions differ.`);
        console.log(`  Update the local CLI: curl -fsSL ${config.api}/install.sh | sh -s -- ${config.api}`);
      }
    } catch (e: any) {
      console.log(`remote:  (could not reach ${config.api}: ${e.message})`);
    }
  });

// ── init ──────────────────────────────────────────────────────────────

program
  .command("init <space>")
  .description("Create .sideways.yml in the current directory")
  .option("--api <url>", "API base URL")
  .action((space: string, opts: { api?: string }) => {
    const slug = slugFromFilename(space);
    if (slug !== space) {
      console.log(`Slugified: "${space}" → "${slug}"`);
    }
    // Use: explicit --api > stored credentials URL
    const creds = getStoredCredentials();
    const api = opts.api || creds?.api_url;
    if (!api) {
      console.error("No API URL. Run 'sideways login' first, or pass --api <url>.");
      process.exit(1);
    }
    const path = createConfig(process.cwd(), slug, api, space);
    console.log(`Created ${path}`);
  });

// ── Shared helpers ────────────────────────────────────────────────────

function getClient(apiUrl: string) {
  const actorName = program.opts().as;
  return createClient(apiUrl, actorName);
}

/** Resolve a path or filename argument to one of the discovered files.
 *  Matches first by exact (sectionSlug, path) (computed via mounts), then
 *  by relPath, then by filename, then by slug. */
function resolveFile(
  files: DiscoveredFile[],
  config: ProjectConfig,
  input: string,
): DiscoveredFile | undefined {
  const resolved = resolveArg(config, input);
  if (resolved) {
    const k = syncKey(resolved.sectionSlug, resolved.path);
    const hit = files.find(f => syncKey(f.sectionSlug, f.path) === k);
    if (hit) return hit;
  }
  return files.find(f =>
    f.relPath === input ||
    f.filename === input ||
    f.slug === input ||
    f.slug === slugFromFilename(basename(input)),
  );
}

/**
 * Resolve a user input to a `(sectionSlug, path)` pair for server calls.
 * Accepts a filesystem path under a configured mount; errors if it can't
 * be resolved.
 */
function resolveDocRef(
  config: ProjectConfig,
  input: string,
): { sectionSlug: string; path: string } {
  const resolved = resolveArg(config, input);
  if (!resolved) {
    console.error(`Path "${input}" is not under any declared section mount.`);
    printPathHint(config, input);
    process.exit(1);
  }
  return { sectionSlug: resolved.sectionSlug, path: resolved.path };
}

/** Print a "did you mean?" hint when a path argument doesn't resolve. */
function printPathHint(config: ProjectConfig, arg: string): void {
  const matches = suggestPaths(config, arg);
  if (matches.length === 0) return;
  console.error("  Did you mean:");
  for (const m of matches.slice(0, 3)) {
    console.error(`    ${m.sectionSlug}/${m.path}`);
  }
}

/** Prepare a file's content for writing to disk (frontmatter + comments) */
async function prepareFileForDisk(
  client: ReturnType<typeof createClient>,
  space: string,
  doc: any,
  opts: { clean?: boolean; includeResolved?: boolean },
): Promise<string> {
  let content = doc.content;

  const fm: Record<string, any> = {};
  const headingMatch = content.match(/^#\s+(.+)$/m);
  const headingTitle = headingMatch ? headingMatch[1].trim() : null;
  // Title in frontmatter only when it differs from the H1 — basename comparison
  // would be too noisy (most filenames don't title-case to the doc title).
  if (doc.title && doc.title !== headingTitle) {
    fm.title = doc.title;
  }
  if (doc.tags?.length > 0) fm.tags = doc.tags;

  if (!opts.clean) {
    try {
      const rawComments = await client.getComments(space, doc.sectionSlug, doc.path, !!opts.includeResolved);
      if (rawComments.length > 0) {
        const serialized: SerializedComment[] = rawComments.map((c: any) => ({
          id: c.id, author: c.author?.name || "Unknown", authorEmail: c.author?.email,
          date: c.createdAt?.slice(0, 10) || "", body: c.body,
          anchorText: c.anchorText, anchorSection: c.anchorSection,
          anchorContext: c.anchorContext, parentId: c.parentId, resolved: c.resolved,
        }));
        content = embedComments(content, serialized);
      }
    } catch {}
  }

  return Object.keys(fm).length > 0 ? serializeFrontmatter(fm, content) : content;
}

/** Read a local file and prepare for push */
function prepareFileForPush(filePath: string): { content: string; tags: string[]; title?: string } {
  const raw = readFileSync(filePath, "utf-8");
  const { clean } = extractComments(raw);
  const { frontmatter, content } = parseFrontmatter(clean);
  if (frontmatter.slug) {
    console.warn(`warning: frontmatter 'slug:' is no longer used (path is the identifier) — ${filePath}`);
  }
  const tags = frontmatter.tags || [];
  return { content, tags, title: frontmatter.title };
}

// ── add / remove ──────────────────────────────────────────────────────

program
  .command("add <paths...>")
  .description("Track files or directories for sync (use '.' for everything)")
  .action((paths: string[]) => {
    const config = requireConfig();
    const syncRoot = config.rootDir;
    const mountList = buildMounts(config);
    const tracked = readTracked(syncRoot) || [];
    const allFiles = discoverFiles(config.rootDir, mountList, config.ignore);

    let added = 0;
    for (const p of paths) {
      if (p === ".") {
        // Track everything — empty list means "all"
        writeTracked(syncRoot, []);
        console.log("Tracking all files (cleared explicit tracking list).");
        return;
      }

      // Resolve to relative path from sync root
      const abs = resolve(p);
      const rel = relative(syncRoot, abs);

      // Check if it's a directory
      if (existsSync(abs) && statSync(abs).isDirectory()) {
        const dirRel = rel.endsWith("/") ? rel : rel + "/";
        if (!tracked.includes(rel) && !tracked.includes(dirRel)) {
          tracked.push(rel);
          const matching = allFiles.filter(f => f.relPath.startsWith(dirRel) || f.relPath.startsWith(rel + "/"));
          console.log(`  added: ${rel}/ (${matching.length} files)`);
          added++;
        }
        continue;
      }

      // Single file
      const file = allFiles.find(f => f.relPath === rel || f.filename === basename(p) || f.slug === slugFromFilename(basename(p)));
      if (file) {
        if (!tracked.includes(file.relPath)) {
          tracked.push(file.relPath);
          console.log(`  added: ${file.relPath}`);
          added++;
        }
      } else {
        // Check if the file actually exists on disk
        if (existsSync(abs) && statSync(abs).isFile()) {
          if (!tracked.includes(rel)) {
            tracked.push(rel);
            console.log(`  added: ${rel}`);
            added++;
          }
        } else {
          console.error(`  not found: ${p}`);
        }
      }
    }

    if (added > 0) {
      writeTracked(syncRoot, tracked);
      console.log(`\n${added} path(s) added. ${tracked.length} total tracked.`);
    } else {
      console.log("Nothing new to add.");
    }
  });

program
  .command("remove <paths...>")
  .description("Stop tracking files or directories for sync")
  .action((paths: string[]) => {
    const config = requireConfig();
    const syncRoot = config.rootDir;
    let tracked = readTracked(syncRoot);

    if (!tracked || tracked.length === 0) {
      console.log("Currently tracking everything. Use 'sideways add <path>' to switch to selective tracking first.");
      return;
    }

    let removed = 0;
    for (const p of paths) {
      const abs = resolve(p);
      const rel = relative(syncRoot, abs);
      const before = tracked.length;
      tracked = tracked.filter(t => t !== rel && t !== rel + "/" && t !== basename(p));
      if (tracked.length < before) {
        console.log(`  removed: ${rel}`);
        removed++;
      }
    }

    if (removed > 0) {
      writeTracked(syncRoot, tracked);
      console.log(`\n${removed} path(s) removed. ${tracked.length} total tracked.`);
    } else {
      console.log("Nothing to remove.");
    }
  });

// ── pull ──────────────────────────────────────────────────────────────

program
  .command("pull [path]")
  .description("Pull documents from remote to local files")
  .option("--space <space>", "Override space from config")
  .option("--clean", "Exclude comments from output")
  .option("--include-resolved", "Include resolved comments")
  .option("--force", "Overwrite local changes")
  .action(
    async (
      path: string | undefined,
      opts: { space?: string; clean?: boolean; includeResolved?: boolean; force?: boolean },
    ) => {
      const config = requireConfig();
      const space = opts.space ?? config.space;
      const client = getClient(config.api);
      const syncRoot = config.rootDir;

      await requireSpace(client, space, { createHint: true });

      // Single file pull — `path` is a filesystem path that resolves to
      // (sectionSlug, path). If the file doesn't exist locally yet, we
      // still need a section to look up the doc on the server, so the path
      // must fall under one of the configured mounts.
      if (path && (path.endsWith(".md") || !path.includes("/"))) {
        const filePath = resolve(path.endsWith(".md") ? path : `${path}.md`);
        const resolved = resolveArg(config, filePath);
        if (!resolved) {
          console.error(`Path "${path}" is not under any declared section mount.`);
          printPathHint(config, path);
          process.exit(1);
        }
        const doc = await client.getDocument(space, resolved.sectionSlug, resolved.path);
        const output = await prepareFileForDisk(client, space, doc, opts);

        writeFileSync(filePath, output);

        const relPath = relative(syncRoot, filePath);
        const tracked = readTracked(syncRoot) || [];
        if (tracked.length > 0 && !isTracked(tracked, relPath)) {
          tracked.push(relPath);
          writeTracked(syncRoot, tracked);
        }

        const syncInfo = await client.getSyncInfo(space).catch(() => [] as SyncInfo[]);
        const remote = syncInfo.find(
          (r: SyncInfo) => r.sectionSlug === resolved.sectionSlug && r.path === resolved.path,
        );
        if (remote) {
          const syncState = readSyncState(syncRoot, space);
          syncState.files[syncKey(resolved.sectionSlug, resolved.path)] = {
            sectionSlug: resolved.sectionSlug,
            path: resolved.path,
            slug: slugFromFilename(basename(filePath)),
            remoteVersion: remote.version,
            localHash: hashLocalFile(output),
            remoteHash: remote.contentHash,
          };
          syncState.lastSync = new Date().toISOString();
          writeSyncState(syncRoot, syncState);
        }

        console.log(`Pulled ${space}/${resolved.sectionSlug}/${resolved.path} → ${filePath}`);
        return;
      }

      // Full pull — fetch sync metadata, place each doc at
      // <mountDir>/<doc.path> inside its owned section. Sections not
      // declared in `.sideways.yml` are skipped.
      mkdirSync(syncRoot, { recursive: true });

      const syncInfo = await client.getSyncInfo(space);
      const syncState = readSyncState(syncRoot, space);
      const sectionPathMap = new Map<string, string>(Object.entries(config.sections));

      let totalPulled = 0;
      let totalSkipped = 0;
      const undeclaredSectionCounts = new Map<string, number>();

      for (const r of syncInfo) {
        const mountRel = sectionPathMap.get(r.sectionSlug);
        if (!mountRel) {
          undeclaredSectionCounts.set(
            r.sectionSlug,
            (undeclaredSectionCounts.get(r.sectionSlug) ?? 0) + 1,
          );
          totalSkipped++;
          continue;
        }
        const relativePath = normalise(join(mountRel, r.path));
        const filePath = join(syncRoot, relativePath);
        const key = syncKey(r.sectionSlug, r.path);
        const tracked = syncState.files[key];

        // Remote hasn't moved since last sync — skip without fetching or
        // rewriting the local file. Without this, every pull re-fetches
        // every doc and rewrites every file (touching mtimes and, more
        // damagingly, exposing any silent push/pull lossiness like the
        // frontmatter-strip bug).
        if (tracked && r.contentHash === tracked.remoteHash && !opts.force) {
          totalSkipped++;
          continue;
        }

        // Conflict check
        if (tracked && !opts.force) {
          try {
            const localContent = readFileSync(filePath, "utf-8");
            const localHash = hashLocalFile(localContent);
            if (localHash !== tracked.localHash && r.contentHash !== tracked.remoteHash) {
              console.log(`  conflict: ${relativePath} (use --force to overwrite)`);
              totalSkipped++;
              continue;
            }
          } catch {}
        }

        const fullDoc = await client.getDocument(space, r.sectionSlug, r.path);
        const output = await prepareFileForDisk(client, space, fullDoc, opts);

        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, output);

        syncState.files[key] = {
          sectionSlug: r.sectionSlug,
          path: r.path,
          slug: slugFromFilename(basename(r.path)),
          remoteVersion: r.version,
          localHash: hashLocalFile(output),
          remoteHash: r.contentHash,
        };

        const isNew = !tracked;
        console.log(`  ${isNew ? "new" : "updated"}: ${relativePath}`);
        totalPulled++;
      }

      syncState.lastSync = new Date().toISOString();
      writeSyncState(syncRoot, syncState);

      if (undeclaredSectionCounts.size > 0) {
        console.log("\nSections on remote not mapped in .sideways.yml (skipped):");
        const sortedSections = [...undeclaredSectionCounts.entries()].sort(
          (a, b) => a[0].localeCompare(b[0]),
        );
        for (const [section, count] of sortedSections) {
          console.log(`  ${section} — ${count} doc${count !== 1 ? "s" : ""}`);
        }
      }

      if (totalPulled === 0) {
        console.log("Nothing to pull.");
      } else {
        console.log(`\nPulled ${totalPulled} file(s)${totalSkipped > 0 ? `, ${totalSkipped} skipped` : ""}`);
      }
    },
  );

// ── push ──────────────────────────────────────────────────────────────

program
  .command("push [path]")
  .description("Push local changes to remote")
  .option("--space <space>", "Override space from config")
  .option("--dry-run", "Show what would change without doing it")
  .option("--force", "Overwrite remote even on conflict")
  .action(
    async (
      path: string | undefined,
      opts: { space?: string; dryRun?: boolean; force?: boolean },
    ) => {
      const config = requireConfig();
      const space = opts.space ?? config.space;
      const client = getClient(config.api);
      const syncRoot = config.rootDir;
    const mountList = buildMounts(config);

      if (!opts.dryRun) {
        await ensureSpace(client, space, config.spaceName || undefined);
      }

      // Discover all files from the sync root, filtered by tracked list
      const tracked = readTracked(syncRoot);
      if (tracked === null) {
        console.error("No files tracked. Run 'sideways add <path>' or 'sideways add .' first.");
        process.exit(1);
      }
      const allFiles = discoverFiles(config.rootDir, mountList, config.ignore).filter(f => isTracked(tracked, f.relPath));

      // If path targets a single file, filter to just that
      let files = allFiles;
      if (path && path.endsWith(".md")) {
        const absPath = resolve(path);
        const relPath = relative(syncRoot, absPath);
        files = allFiles.filter(f => f.relPath === relPath);
        if (files.length === 0) {
          // File not in any configured mount — must be pushable via resolveArg
          const resolved = resolveArg(config, absPath);
          if (!resolved) {
            console.error(`Path "${path}" is not under any declared section mount.`);
            printPathHint(config, path);
            process.exit(1);
          }
          const { content, tags, title } = prepareFileForPush(absPath);
          if (opts.dryRun) {
            console.log(`  would push: ${resolved.sectionSlug}/${resolved.path}`);
            return;
          }
          if (!opts.force) {
            const remoteInfo = await client.getSyncInfo(space);
            const existing = remoteInfo.find(
              (r) => r.sectionSlug === resolved.sectionSlug && r.path === resolved.path,
            );
            if (existing) {
              const syncState = readSyncState(syncRoot, space);
              const tracked = syncState.files[syncKey(resolved.sectionSlug, resolved.path)];
              if (tracked && existing.contentHash !== tracked.remoteHash) {
                console.error(`  conflict: ${resolved.sectionSlug}/${resolved.path} has been modified on remote. Use --force to overwrite.`);
                return;
              }
            }
          }
          const body: Record<string, any> = { content, tags };
          if (title) body.title = title;
          const result = await client.putDocument(space, resolved.sectionSlug, resolved.path, body);
          console.log(`Pushed ${space}/${resolved.sectionSlug}/${resolved.path} (${result.id})`);
          return;
        }
      }

      // Reconcile sections to match the order of `.sideways.yml`'s `sections:` map.
      // YAML preserves insertion order on parse, so Object.keys gives us the
      // user-intended display order. We upsert each non-`default` section
      // with its index as `position`; `default` is server-managed and reserved.
      if (!opts.dryRun) {
        const yamlSections = Object.keys(config.sections);
        for (const [index, sectionSlug] of yamlSections.entries()) {
          if (sectionSlug === "default") continue;
          await client.putSection(space, sectionSlug, { position: index }).catch(() => {});
        }
      }

      // Get remote state for diff
      const remoteFiles = await client.getSyncInfo(space);
      const remoteMap = new Map(remoteFiles.map((r) => [syncKey(r.sectionSlug, r.path), r]));
      const syncState = readSyncState(syncRoot, space);

      let totalPushed = 0;

      // Push parents before children (shallower path = ancestor first).
      const depth = (p: string) => p.split("/").length;
      const sorted = [...files].sort((a, b) => depth(a.path) - depth(b.path));

      for (const file of sorted) {
        const filePath = join(syncRoot, file.relPath);
        const raw = readFileSync(filePath, "utf-8");
        const localHash = hashLocalFile(raw);
        const tracked = syncState.files[syncKey(file.sectionSlug, file.path)];
        const remote = remoteMap.get(syncKey(file.sectionSlug, file.path));

        // Compute status
        let status: string;
        if (!tracked && !remote) status = "new-local";
        else if (!tracked && remote) {
          // Not tracked — compare hashes; if different, use mtime to decide direction
          if (localHash === remote.contentHash) {
            status = "unchanged";
          } else {
            const localMtime = statSync(filePath).mtimeMs;
            const remoteMtime = remote.updatedAt ? new Date(remote.updatedAt).getTime() : 0;
            status = localMtime > remoteMtime ? "local-modified" : "remote-modified";
          }
        }
        else if (tracked && !remote) status = "new-local";
        else if (tracked) {
          const localChanged = localHash !== tracked.localHash;
          const remoteChanged = remote && remote.contentHash !== tracked.remoteHash;
          if (localChanged && remoteChanged) status = "conflict";
          else if (localChanged) status = "local-modified";
          else if (remoteChanged) status = "remote-modified";
          else status = "unchanged";
        } else status = "unchanged";

        // Drift detection: server has this doc at a different (section, path)
        // than the local config places it. Path/section are URL-keyed now,
        // so a section-drift implies it's a different doc on the server.
        // Path drift is not possible since we look up by (section, path).
        // Keep this as-is in case future code paths could trigger.
        if (status === "unchanged" && remote) {
          const sectionDrift = remote.sectionSlug !== file.sectionSlug;
          if (sectionDrift) {
            status = "local-modified";
          }
        }

        if (status === "unchanged" || status === "remote-modified") continue;
        if (status === "conflict" && !opts.force) {
          console.log(`  conflict: ${file.relPath} (use --force to overwrite)`);
          continue;
        }

        if (opts.dryRun) {
          console.log(`  would push: ${file.relPath} → ${file.sectionSlug}/${file.path} (${status})`);
          totalPushed++;
          continue;
        }

        const { clean } = extractComments(raw);
        const { frontmatter, content } = parseFrontmatter(clean);
        if (frontmatter.slug) {
          console.warn(`warning: frontmatter 'slug:' is no longer used (path is the identifier) — ${file.relPath}`);
        }
        const tags = frontmatter.tags || [];
        const body: Record<string, any> = { content, tags };
        if (frontmatter.title) body.title = frontmatter.title;
        // Preserve local file timestamp so mtime-based fallback works
        body.updatedAt = statSync(filePath).mtime.toISOString();

        await client.putDocument(space, file.sectionSlug, file.path, body);

        syncState.files[syncKey(file.sectionSlug, file.path)] = {
          sectionSlug: file.sectionSlug,
          path: file.path,
          slug: file.slug,
          remoteVersion: (tracked?.remoteVersion ?? 0) + 1,
          localHash,
          remoteHash: localHash,
        };

        console.log(`  pushed: ${file.relPath} → ${file.sectionSlug}/${file.path} (${status})`);
        totalPushed++;
      }

      if (!opts.dryRun) {
        // Refresh remote state and ensure ALL local files are tracked
        const updatedRemote = await client.getSyncInfo(space);
        const remoteHashMap = new Map(updatedRemote.map((r) => [syncKey(r.sectionSlug, r.path), r]));

        for (const file of sorted) {
          const remote = remoteHashMap.get(syncKey(file.sectionSlug, file.path));
          if (!remote) continue;

          if (syncState.files[syncKey(file.sectionSlug, file.path)]) {
            // Already tracked — update remote hash/version
            syncState.files[syncKey(file.sectionSlug, file.path)].remoteHash = remote.contentHash;
            syncState.files[syncKey(file.sectionSlug, file.path)].remoteVersion = remote.version;
          } else {
            // Not tracked yet — record it now
            const filePath = join(syncRoot, file.relPath);
            const raw = readFileSync(filePath, "utf-8");
            syncState.files[syncKey(file.sectionSlug, file.path)] = {
              sectionSlug: file.sectionSlug,
              path: file.path,
              slug: file.slug,
              remoteVersion: remote.version,
              localHash: hashLocalFile(raw),
              remoteHash: remote.contentHash,
            };
          }
        }

        syncState.lastSync = new Date().toISOString();
        writeSyncState(syncRoot, syncState);
      }

      if (totalPushed === 0 && !opts.dryRun) {
        console.log("Nothing to push.");
      } else if (!opts.dryRun) {
        console.log(`\nPushed ${totalPushed} file(s)`);
      }
    },
  );

// ── status ────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show sync status of local files")
  .option("--space <space>", "Override space from config")
  .action(async (opts: { space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);
    const syncRoot = config.rootDir;
    const mountList = buildMounts(config);

    await requireSpace(client, space);

    const tracked = readTracked(syncRoot);
    if (tracked === null) {
      console.log("\x1b[33mNo files tracked yet. Run 'sideways add <path>' or 'sideways add .' to start.\x1b[0m\n");
    }
    const files = discoverFiles(config.rootDir, mountList, config.ignore).filter(f => isTracked(tracked, f.relPath));
    const remoteFiles = await client.getSyncInfo(space);
    const remoteMap = new Map(remoteFiles.map((r) => [syncKey(r.sectionSlug, r.path), r]));
    const syncState = readSyncState(syncRoot, space);

    // Fetch comment counts for remote docs — keyed by (sectionSlug, path).
    let commentCounts = new Map<string, number>();
    try {
      const counts = await client.getCommentCounts(space);
      commentCounts = new Map(counts.map((r) => [syncKey(r.sectionSlug, r.path), r.count]));
    } catch {}

    const sorted = [...files].sort((a, b) => a.relPath.localeCompare(b.relPath));

    function show(label: string, file: { relPath: string; sectionSlug: string; path: string }) {
      const colors: Record<string, string> = {
        "new-local": "\x1b[32m",
        "local-modified": "\x1b[33m",
        "remote-modified": "\x1b[36m",
        conflict: "\x1b[31m",
        deleted: "\x1b[31m",
        "new-remote": "\x1b[36m",
      };
      const color = colors[label] || "";
      const reset = color ? "\x1b[0m" : "";
      const cc = commentCounts.get(syncKey(file.sectionSlug, file.path));
      const commentInfo = cc ? ` \x1b[35m[${cc} comment${cc !== 1 ? "s" : ""}]\x1b[0m` : "";
      console.log(`  ${color}${label.padEnd(16)}${reset} ${file.relPath}${commentInfo}`);
    }

    let hasChanges = false;
    for (const file of sorted) {
      const filePath = join(syncRoot, file.relPath);
      const raw = readFileSync(filePath, "utf-8");
      const localHash = hashLocalFile(raw);
      const tracked = syncState.files[syncKey(file.sectionSlug, file.path)];
      const remote = remoteMap.get(syncKey(file.sectionSlug, file.path));

      let status: string;
      if (!tracked && !remote) status = "new-local";
      else if (!tracked && remote) {
        if (localHash === remote.contentHash) {
          status = "unchanged";
        } else {
          const localMtime = statSync(filePath).mtimeMs;
          const remoteMtime = remote.updatedAt ? new Date(remote.updatedAt).getTime() : 0;
          status = localMtime > remoteMtime ? "local-modified" : "remote-modified";
        }
      }
      else if (tracked && !remote) status = "new-local";
      else if (tracked) {
        const localChanged = localHash !== tracked.localHash;
        const remoteChanged = remote && remote.contentHash !== tracked.remoteHash;
        if (localChanged && remoteChanged) status = "conflict";
        else if (localChanged) status = "local-modified";
        else if (remoteChanged) status = "remote-modified";
        else status = "unchanged";
      } else status = "unchanged";

      if (status !== "unchanged") {
        show(status, file);
        hasChanges = true;
      }
    }

    // Check for remote-only files. Two cases:
    //  - Section IS declared in .sideways.yml: show the new-remote file at
    //    its local mount path (the same place pull will write it).
    //  - Section is NOT declared: skip the per-file lines (pull won't touch
    //    these — a single remote space can host docs from multiple local
    //    repos), and emit one summary line per skipped section so the user
    //    knows they exist.
    const localKeys = new Set(files.map(f => syncKey(f.sectionSlug, f.path)));
    const undeclaredSectionCounts = new Map<string, number>();
    for (const remote of remoteFiles) {
      const key = syncKey(remote.sectionSlug, remote.path);
      if (localKeys.has(key)) continue;
      const mountRel = config.sections[remote.sectionSlug];
      if (mountRel) {
        const relPath = normalise(join(mountRel, remote.path));
        show("new-remote", { relPath, sectionSlug: remote.sectionSlug, path: remote.path });
        hasChanges = true;
      } else {
        undeclaredSectionCounts.set(
          remote.sectionSlug,
          (undeclaredSectionCounts.get(remote.sectionSlug) ?? 0) + 1,
        );
      }
    }
    if (undeclaredSectionCounts.size > 0) {
      console.log("\nSections on remote not mapped in .sideways.yml (not pulled):");
      const sortedSections = [...undeclaredSectionCounts.entries()].sort(
        (a, b) => a[0].localeCompare(b[0]),
      );
      for (const [section, count] of sortedSections) {
        console.log(`  ${section} — ${count} doc${count !== 1 ? "s" : ""}`);
      }
    }

    // Show unchanged files that have open comments
    for (const file of sorted) {
      const cc = commentCounts.get(syncKey(file.sectionSlug, file.path));
      if (cc) {
        const filePath = join(syncRoot, file.relPath);
        const raw = readFileSync(filePath, "utf-8");
        const localHash = hashLocalFile(raw);
        const trackedEntry = syncState.files[syncKey(file.sectionSlug, file.path)];
        const remote = remoteMap.get(syncKey(file.sectionSlug, file.path));
        const isUnchanged = trackedEntry && remote && localHash === trackedEntry.localHash && remote.contentHash === trackedEntry.remoteHash;
        if (isUnchanged) {
          console.log(`  ${"".padEnd(16)} ${file.relPath} \x1b[35m[${cc} comment${cc !== 1 ? "s" : ""}]\x1b[0m`);
        }
      }
    }

    // Show untracked files when selective tracking is active
    if (tracked && tracked.length > 0) {
      const allDiscovered = discoverFiles(config.rootDir, mountList, config.ignore);
      const untracked = allDiscovered.filter(f => !isTracked(tracked, f.relPath));
      if (untracked.length > 0) {
        console.log(`\n  ${untracked.length} untracked file(s) — use 'sideways add <path>' to track`);
      }
    }

    if (!hasChanges) {
      console.log("Everything up to date.");
    }
  });

// ── sync ──────────────────────────────────────────────────────────────

program
  .command("sync")
  .description("Bidirectional sync: pull remote changes + push local changes")
  .option("--space <space>", "Override space from config")
  .option("--dry-run", "Show what would change without doing it")
  .option("--clean", "Exclude comments when pulling")
  .option("--reconcile", "Compare actual content for mismatched hashes (slower, useful after fresh init)")
  .action(async (opts: { space?: string; dryRun?: boolean; clean?: boolean; reconcile?: boolean }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);
    const syncRoot = config.rootDir;
    const mountList = buildMounts(config);

    if (!opts.dryRun) {
      await ensureSpace(client, space, config.spaceName || undefined);
    }

    const tracked = readTracked(syncRoot);
    if (tracked === null) {
      console.error("No files tracked. Run 'sideways add <path>' or 'sideways add .' first.");
      process.exit(1);
    }
    const allFiles = discoverFiles(config.rootDir, mountList, config.ignore).filter(f => isTracked(tracked, f.relPath));
    const remoteFiles = await client.getSyncInfo(space);
    const remoteMap = new Map(remoteFiles.map((r) => [syncKey(r.sectionSlug, r.path), r]));
    const syncState = readSyncState(syncRoot, space);

    // Classify all files
    type PullEntry = { sectionSlug: string; path: string; relativePath: string };
    const toPull: PullEntry[] = [];
    const toPush: { file: (typeof allFiles)[0]; raw: string }[] = [];
    const conflicts: string[] = [];
    const localKeys = new Set<string>();

    for (const file of allFiles) {
      const key = syncKey(file.sectionSlug, file.path);
      localKeys.add(key);
      const filePath = join(syncRoot, file.relPath);
      const raw = readFileSync(filePath, "utf-8");
      const localHash = hashLocalFile(raw);
      const tracked = syncState.files[key];
      const remote = remoteMap.get(key);

      let status: string;
      if (!tracked && !remote) status = "new-local";
      else if (!tracked && remote) {
        if (localHash === remote.contentHash) {
          status = "unchanged";
        } else {
          const localMtime = statSync(filePath).mtimeMs;
          const remoteMtime = remote.updatedAt ? new Date(remote.updatedAt).getTime() : 0;
          status = localMtime > remoteMtime ? "local-modified" : "remote-modified";
        }
      }
      else if (tracked && !remote) status = "new-local";
      else if (tracked) {
        const localChanged = localHash !== tracked.localHash;
        const remoteChanged = remote && remote.contentHash !== tracked.remoteHash;
        if (localChanged && remoteChanged) status = "conflict";
        else if (localChanged) status = "local-modified";
        else if (remoteChanged) status = "remote-modified";
        else status = "unchanged";
      } else status = "unchanged";

      // Reconcile: if hashes differ but actual content matches, treat as unchanged
      if (opts.reconcile && remote && (status === "conflict" || status === "remote-modified" || status === "local-modified")) {
        const remoteDoc = await client.getDocument(space, file.sectionSlug, file.path);
        const { clean: localClean } = extractComments(raw);
        const { content: localContent } = parseFrontmatter(localClean);
        if (localContent.trim() === remoteDoc.content.trim()) {
          console.log(`  \x1b[2mreconciled\x1b[0m  ${file.relPath}`);
          syncState.files[key] = {
            sectionSlug: file.sectionSlug,
            path: file.path,
            slug: file.slug,
            remoteVersion: remote.version,
            localHash,
            remoteHash: remote.contentHash,
          };
          // Update remote timestamp to match local
          const localMtime = statSync(filePath).mtime.toISOString();
          await client.putDocument(space, file.sectionSlug, file.path, { updatedAt: localMtime });
          continue;
        }
      }

      if (status === "unchanged") {
        if (!tracked && remote) {
          syncState.files[key] = {
            sectionSlug: file.sectionSlug,
            path: file.path,
            slug: file.slug,
            remoteVersion: remote.version,
            localHash,
            remoteHash: remote.contentHash,
          };
        }
        continue;
      }
      if (status === "conflict") { conflicts.push(file.relPath); continue; }
      if (status === "remote-modified") {
        toPull.push({ sectionSlug: file.sectionSlug, path: file.path, relativePath: file.relPath });
        continue;
      }
      if (status === "new-local" || status === "local-modified") { toPush.push({ file, raw }); }
    }

    // Check for remote-only files (new on remote)
    const sectionPathMap = new Map<string, string>(Object.entries(config.sections));
    for (const remote of remoteFiles) {
      const key = syncKey(remote.sectionSlug, remote.path);
      if (!localKeys.has(key)) {
        const mountRel = sectionPathMap.get(remote.sectionSlug);
        if (!mountRel) continue; // Section not owned locally; skip.
        toPull.push({
          sectionSlug: remote.sectionSlug,
          path: remote.path,
          relativePath: normalise(join(mountRel, remote.path)),
        });
      }
    }

    if (toPull.length === 0 && toPush.length === 0 && conflicts.length === 0) {
      console.log("Everything up to date.");
      return;
    }

    // Pull remote changes
    if (toPull.length > 0) {
      console.log(`\nPulling ${toPull.length} file(s):`);
      for (const { sectionSlug, path: docPath, relativePath } of toPull) {
        if (opts.dryRun) {
          console.log(`  would pull: ${relativePath}`);
          continue;
        }
        const doc = await client.getDocument(space, sectionSlug, docPath);
        const output = await prepareFileForDisk(client, space, doc, { clean: opts.clean });
        const filePath = join(syncRoot, relativePath);
        mkdirSync(join(filePath, ".."), { recursive: true });
        writeFileSync(filePath, output);

        const remoteInfo = remoteMap.get(syncKey(sectionSlug, docPath));
        if (remoteInfo) {
          syncState.files[syncKey(sectionSlug, docPath)] = {
            sectionSlug,
            path: docPath,
            slug: slugFromFilename(basename(docPath)),
            remoteVersion: remoteInfo.version ?? 1,
            localHash: hashLocalFile(output),
            remoteHash: remoteInfo.contentHash ?? hashLocalFile(output),
          };
        }
        console.log(`  pulled: ${relativePath}`);
      }
    }

    // Push local changes
    if (toPush.length > 0) {
      // Reconcile section order from `.sideways.yml`. Same logic as `push`.
      if (!opts.dryRun) {
        const yamlSections = Object.keys(config.sections);
        for (const [index, sectionSlug] of yamlSections.entries()) {
          if (sectionSlug === "default") continue;
          await client.putSection(space, sectionSlug, { position: index }).catch(() => {});
        }
      }

      console.log(`\nPushing ${toPush.length} file(s):`);
      const pushDepth = (p: string) => p.split("/").length;
      const sorted = [...toPush].sort((a, b) => pushDepth(a.file.path) - pushDepth(b.file.path));
      for (const { file, raw } of sorted) {
        if (opts.dryRun) {
          console.log(`  would push: ${file.relPath}`);
          continue;
        }
        const { clean } = extractComments(raw);
        const { frontmatter, content } = parseFrontmatter(clean);
        if (frontmatter.slug) {
          console.warn(`warning: frontmatter 'slug:' is no longer used (path is the identifier) — ${file.relPath}`);
        }
        const tags = frontmatter.tags || [];
        const body: Record<string, any> = { content, tags };
        if (frontmatter.title) body.title = frontmatter.title;
        body.updatedAt = statSync(join(syncRoot, file.relPath)).mtime.toISOString();

        await client.putDocument(space, file.sectionSlug, file.path, body);

        const localHash = hashLocalFile(raw);
        syncState.files[syncKey(file.sectionSlug, file.path)] = {
          sectionSlug: file.sectionSlug,
          path: file.path,
          slug: file.slug,
          remoteVersion: (syncState.files[syncKey(file.sectionSlug, file.path)]?.remoteVersion ?? 0) + 1,
          localHash,
          remoteHash: localHash,
        };
        console.log(`  pushed: ${file.relPath}`);
      }
    }

    // Show conflicts
    if (conflicts.length > 0) {
      console.log(`\n${conflicts.length} conflict(s):`);
      for (const f of conflicts) {
        console.log(`  \x1b[31mconflict\x1b[0m  ${f}`);
      }
      console.log("\nResolve with:");
      console.log("  sideways push --force <file>   (keep local)");
      console.log("  sideways pull --force <file>   (keep remote)");
    }

    if (!opts.dryRun) {
      // Refresh remote state for pushed files
      const updatedRemote = await client.getSyncInfo(space);
      const remoteHashMap = new Map(updatedRemote.map((r) => [syncKey(r.sectionSlug, r.path), r]));
      for (const entry of Object.values(syncState.files)) {
        const remote = remoteHashMap.get(syncKey(entry.sectionSlug, entry.path));
        if (remote) {
          entry.remoteHash = remote.contentHash;
          entry.remoteVersion = remote.version;
        }
      }
      syncState.lastSync = new Date().toISOString();
      writeSyncState(syncRoot, syncState);
    }
  });

// ── diff ──────────────────────────────────────────────────────────────

program
  .command("diff [path]")
  .description("Show content differences between local and remote")
  .option("--space <space>", "Override space from config")
  .action(async (input: string | undefined, opts: { space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);
    const syncRoot = config.rootDir;
    const mountList = buildMounts(config);

    if (!input) {
      console.error("Usage: sideways diff <path>");
      process.exit(1);
    }

    const files = discoverFiles(config.rootDir, mountList, config.ignore);
    const file = resolveFile(files, config, input);
    if (!file) {
      console.error(`No local file found for "${input}"`);
      printPathHint(config, input);
      process.exit(1);
    }

    const filePath = join(syncRoot, file.relPath);
    const raw = readFileSync(filePath, "utf-8");
    const { clean } = extractComments(raw);
    const { content: localContent } = parseFrontmatter(clean);

    try {
      const doc = await client.getDocument(space, file.sectionSlug, file.path);
      const remoteContent = doc.content;

      if (localContent.trim() === remoteContent.trim()) {
        console.log("No content differences.");
        return;
      }

      const localLines = localContent.split("\n");
      const remoteLines = remoteContent.split("\n");

      console.log(`--- remote: ${space}/${file.sectionSlug}/${file.path}`);
      console.log(`+++ local: ${file.relPath}`);

      // Simple line diff
      const maxLines = Math.max(localLines.length, remoteLines.length);
      for (let i = 0; i < maxLines; i++) {
        const l = localLines[i];
        const r = remoteLines[i];
        if (l === r) continue;
        if (r !== undefined && l !== r) console.log(`\x1b[31m- ${r}\x1b[0m`);
        if (l !== undefined && l !== r) console.log(`\x1b[32m+ ${l}\x1b[0m`);
      }
    } catch {
      console.log("Document not found on remote — entirely new.");
    }
  });

// ── rename ────────────────────────────────────────────────────────────

program
  .command("rename <path> <new-title>")
  .description("Rename a document's title")
  .option("--space <space>", "Override space from config")
  .option("--target-path <path>", "Also change the path (server-side rename/move)")
  .action(async (input: string, newTitle: string, opts: { space?: string; targetPath?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);
    const { sectionSlug, path } = resolveDocRef(config, input);

    const patch: Record<string, any> = { title: newTitle };
    if (opts.targetPath) patch.targetPath = opts.targetPath;

    const result = await client.patchDocument(space, sectionSlug, path, patch);
    console.log(`Renamed → "${result.title}" (${result.sectionSlug}/${result.path})`);
  });

// ── move ──────────────────────────────────────────────────────────────

program
  .command("move <path> <target-space>")
  .description("Move a document to another space")
  .option("--space <space>", "Override source space from config")
  .action(async (input: string, targetSpace: string, opts: { space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);
    const { sectionSlug, path } = resolveDocRef(config, input);

    const result = await client.patchDocument(space, sectionSlug, path, { targetSpace });
    console.log(`Moved ${sectionSlug}/${path} → ${targetSpace}/${result.sectionSlug}/${result.path}`);
  });

// ── section ──────────────────────────────────────────────────────────

program
  .command("section <path> <section-slug>")
  .description("Move a document into a different section")
  .option("--space <space>", "Override space from config")
  .action(async (input: string, targetSection: string, opts: { space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);
    const { sectionSlug, path } = resolveDocRef(config, input);

    const result = await client.patchDocument(space, sectionSlug, path, { targetSection });
    console.log(`Moved ${sectionSlug}/${path} → section "${targetSection}" (${result.sectionSlug}/${result.path})`);
  });

// ── sections (list / remove) ──────────────────────────────────────────

program
  .command("sections")
  .description("List sections in the space")
  .option("--space <space>", "Override space from config")
  .action(async (opts: { space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);

    const list = await client.listSections(space);
    if (list.length === 0) {
      console.log("No sections.");
      return;
    }
    const sorted = list.slice().sort((a, b) => a.position - b.position);
    const slugWidth = Math.max(...sorted.map((s) => s.slug.length));
    for (const s of sorted) {
      console.log(`  ${s.slug.padEnd(slugWidth)}  ${s.title}`);
    }
  });

program
  .command("section-remove <slug>")
  .description("Delete a section. Use --empty to move its documents to the default section first.")
  .option("--space <space>", "Override space from config")
  .option("--empty", "Move documents to the default section before deleting")
  .action(async (slug: string, opts: { space?: string; empty?: boolean }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);

    await requireSpace(client, space);

    if (opts.empty) {
      const { moved } = await client.emptySection(space, slug);
      if (moved > 0) {
        console.log(`Moved ${moved} document${moved === 1 ? "" : "s"} to the default section.`);
      }
    }

    try {
      await client.deleteSection(space, slug);
    } catch (e: any) {
      if (String(e?.message).includes("not empty")) {
        console.error(`Section "${slug}" still has documents. Re-run with --empty to move them to the default section first.`);
        process.exit(1);
      }
      throw e;
    }
    console.log(`Deleted section ${space}:${slug}`);
  });

// ── duplicate ─────────────────────────────────────────────────────────

program
  .command("duplicate <path>")
  .description("Duplicate a document")
  .option("--space <space>", "Override space from config")
  .option("--target-space <space>", "Target space for the copy")
  .option("--target-section <section>", "Target section for the copy")
  .option("--target-path <path>", "Custom path for the copy")
  .action(async (input: string, opts: { space?: string; targetSpace?: string; targetSection?: string; targetPath?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);
    const { sectionSlug, path } = resolveDocRef(config, input);

    const result = await client.duplicateDocument(space, sectionSlug, path, {
      targetSpace: opts.targetSpace,
      targetSection: opts.targetSection,
      targetPath: opts.targetPath,
    });
    console.log(`Duplicated → ${result.sectionSlug}/${result.path}`);
  });

// ── delete ────────────────────────────────────────────────────────────

program
  .command("delete <path>")
  .description("Delete a document from the server")
  .option("--space <space>", "Override space from config")
  .action(async (input: string, opts: { space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);
    const { sectionSlug, path } = resolveDocRef(config, input);

    await requireSpace(client, space);
    await client.deleteDocument(space, sectionSlug, path);
    console.log(`Deleted ${space}/${sectionSlug}/${path}`);
  });

// ── space-set ─────────────────────────────────────────────────────────

program
  .command("space-set <field> <value>")
  .description("Update space settings (name, description, visibility)")
  .option("--space <space>", "Override space from config")
  .action(async (field: string, value: string, opts: { space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);

    const allowed = ["name", "description", "visibility"];
    if (!allowed.includes(field)) {
      console.error(`Field must be one of: ${allowed.join(", ")}`);
      process.exit(1);
    }

    const result = await client.updateSpace(space, { [field]: value });
    console.log(`Updated ${field} → "${(result as unknown as Record<string, unknown>)[field]}"`);
  });

// ── members ───────────────────────────────────────────────────────────

program
  .command("members")
  .description("List space members")
  .option("--space <space>", "Override space from config")
  .action(async (opts: { space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);

    const members = await client.getSpaceMembers(space);
    if (members.length === 0) {
      console.log("No members.");
      return;
    }
    for (const m of members) {
      console.log(`  ${(m.role || "").padEnd(8)} ${m.name || m.email}`);
    }
  });

program
  .command("member-add <email> [role]")
  .description("Add a member to the space (role: viewer, editor, admin)")
  .option("--space <space>", "Override space from config")
  .action(async (email: string, role: string = "editor", opts: { space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);

    const result = await client.addSpaceMember(space, email, role);
    console.log(`Added ${result.email} as ${result.role}`);
  });

program
  .command("member-remove <member-id>")
  .description("Remove a member from the space")
  .option("--space <space>", "Override space from config")
  .action(async (memberId: string, opts: { space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);

    await client.removeSpaceMember(space, memberId);
    console.log(`Removed member ${memberId}`);
  });

// ── search ────────────────────────────────────────────────────────────

program
  .command("search <query>")
  .description("Search documents by title and content")
  .option("--space <space>", "Limit to a specific space")
  .option("--limit <n>", "Max results", "10")
  .action(async (query: string, opts: { space?: string; limit?: string }) => {
    const config = findConfig();
    const baseUrl = config?.api || getStoredCredentials()?.api_url || "http://localhost:4100";

    const params = new URLSearchParams({ q: query, limit: opts.limit || "10" });
    if (opts.space) params.set("space", opts.space);

    const creds = getStoredCredentials();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (creds?.api_key) headers["Authorization"] = `Bearer ${creds.api_key}`;

    const res = await fetch(`${baseUrl}/api/search?${params}`, { headers });
    if (!res.ok) {
      console.error("Search failed.");
      process.exit(1);
    }

    const data = await res.json();
    if (data.results.length === 0) {
      console.log("No results.");
      return;
    }

    for (const r of data.results) {
      const snippet = (r.snippet || "").replace(/<[^>]+>/g, "").trim();
      console.log(`  \x1b[1m${r.title}\x1b[0m`);
      console.log(`  ${r.url}`);
      if (snippet) console.log(`  \x1b[2m${snippet}\x1b[0m`);
      console.log();
    }

    console.log(`${data.results.length} result(s) of ${data.total}`);
  });

// ── comments ──────────────────────────────────────────────────────────

program
  .command("comments <path>")
  .description("List comments on a document")
  .option("--space <space>", "Override space from config")
  .option("--resolved", "Include resolved comments")
  .action(async (input: string, opts: { space?: string; resolved?: boolean }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);
    const { sectionSlug, path } = resolveDocRef(config, input);

    const comments = await client.getComments(space, sectionSlug, path, !!opts.resolved);
    if (comments.length === 0) {
      console.log("No comments.");
      return;
    }

    // Group replies under their parents
    const roots = comments.filter((c: any) => !c.parentId);
    const byParent = new Map<string, any[]>();
    for (const c of comments) {
      if (c.parentId) {
        if (!byParent.has(c.parentId)) byParent.set(c.parentId, []);
        byParent.get(c.parentId)!.push(c);
      }
    }

    function showComment(c: any, indent: string) {
      const displayName = c.actorName ? `${c.actorName} via ${c.author?.name || "Unknown"}` : (c.author?.name || "Unknown");
      const email = c.author?.email ? ` <${c.author.email}>` : "";
      const time = c.createdAt ? new Date(c.createdAt).toLocaleString() : "";
      const resolved = c.resolved ? " \x1b[33m[RESOLVED]\x1b[0m" : "";
      const section = c.anchorSection ? `\n${indent}    section: ${c.anchorSection}` : "";
      const anchor = c.anchorText ? `\n${indent}    anchor: "${c.anchorText}"` : "";

      console.log(`${indent}\x1b[2m${c.id}\x1b[0m`);
      console.log(`${indent}  ${displayName}${email}  ${time}${resolved}${section}${anchor}`);
      console.log(`${indent}  ${c.body}`);
      console.log();

      // Show replies
      const replies = byParent.get(c.id) || [];
      for (const r of replies) {
        showComment(r, indent + "  ↳ ");
      }
    }

    for (const c of roots) {
      showComment(c, "");
    }
  });

program
  .command("comment <path> <body>")
  .description("Add a comment to a document")
  .option("--space <space>", "Override space from config")
  .option("--anchor <text>", "Anchor comment to specific text in the document")
  .option("--section <heading-path>", "Section heading path for the anchor")
  .option("--reply <id>", "Reply to an existing comment")
  .action(async (input: string, body: string, opts: { space?: string; anchor?: string; section?: string; reply?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);
    const { sectionSlug, path } = resolveDocRef(config, input);

    const payload: Record<string, any> = { body };
    if (opts.anchor) payload.anchorText = opts.anchor;
    if (opts.section) payload.anchorSection = opts.section;
    if (opts.reply) payload.parentId = opts.reply;

    const result = await client.addComment(space, sectionSlug, path, payload as any);
    console.log(`Comment added (${result.id.slice(0, 8)})`);
  });

program
  .command("resolve <comment-id>")
  .description("Toggle resolve/reopen on a comment")
  .action(async (commentId: string) => {
    const config = requireConfig();
    const client = getClient(config.api);
    const result = await client.resolveComment(commentId);
    console.log(`Comment ${result.resolved ? "resolved" : "reopened"}`);
  });

// ── export ────────────────────────────────────────────────────────────

program
  .command("export <path>")
  .description("Export a document as PDF")
  .option("--space <space>", "Override space from config")
  .option("-o, --output <path>", "Output file path")
  .option("--theme <id-or-name>", "Print theme ID or name (overrides space theme)")
  .option("--no-toc", "Omit table of contents")
  .option("--no-title-page", "Omit title page")
  .action(async (input: string, opts: { space?: string; output?: string; theme?: string; toc?: boolean; titlePage?: boolean }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);
    const { sectionSlug, path } = resolveDocRef(config, input);

    const res = await client.downloadPdf(space, sectionSlug, path, {
      toc: opts.toc,
      titlePage: opts.titlePage,
      theme: opts.theme,
    });

    const baseName = path.replace(/\.md$/, "").split("/").pop() || "document";
    const outPath = opts.output || `${baseName}.pdf`;
    const buffer = Buffer.from(await res.arrayBuffer());
    writeFileSync(outPath, buffer);
    console.log(`Exported ${space}/${sectionSlug}/${path} → ${outPath} (${buffer.length} bytes)`);
  });

// ── auth ──────────────────────────────────────────────────────────────

program
  .command("login")
  .description("Log in with an API key")
  .option("--api <url>", "API base URL")
  .action(async (opts: { api?: string }) => {
    const config = findConfig();
    const api = opts.api || config?.api || getStoredCredentials()?.api_url;
    if (!api) {
      console.error("No API URL found. Pass --api <url> or run from a directory with .sideways.yml.");
      process.exit(1);
    }
    await login(api);
  });

program
  .command("logout")
  .description("Clear stored credentials")
  .action(() => {
    clearCredentials();
    console.log("Logged out.");
  });

program
  .command("whoami")
  .description("Show current user")
  .action(() => {
    const creds = getStoredCredentials();
    if (!creds) {
      console.log("Not logged in.");
    } else {
      console.log(`API key: ${creds.api_key.slice(0, 8)}...`);
      if (creds.api_url) console.log(`Server: ${creds.api_url}`);
    }
  });

// ── migrate-config ────────────────────────────────────────────────────

program
  .command("migrate-config")
  .description("Rewrite a legacy .sideways.yml to the path-and-sections schema")
  .action(async () => {
    const { parse: parseYaml, stringify: stringifyYaml } = await import("yaml");
    const cwd = process.cwd();

    // Walk up to find an unvalidated .sideways.yml — findConfig() validates
    // strictly and would error on legacy shape.
    let dir = cwd;
    let configPath: string | null = null;
    while (true) {
      const p = join(dir, ".sideways.yml");
      if (existsSync(p)) { configPath = p; break; }
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
    if (!configPath) {
      console.error("No .sideways.yml found in this directory or any parent.");
      process.exit(1);
    }

    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as any;
    if (!parsed || typeof parsed !== "object") {
      console.error(`Could not parse ${configPath}.`);
      process.exit(1);
    }

    // Derive sections in priority order:
    //   1. Map form already → no change needed (already migrated)
    //   2. Old array `sections: [{path, name, slug}, ...]` → flatten to map
    //   3. Legacy `mappings: [{local, section}, ...]` → use section as slug
    //   4. Bare `root: .` (or nothing) → `default: .`
    const sections: Record<string, string> = {};

    if (parsed.sections && typeof parsed.sections === "object" && !Array.isArray(parsed.sections)) {
      console.log(`${configPath} already uses the path-and-sections schema. Nothing to do.`);
      return;
    }

    if (Array.isArray(parsed.sections)) {
      for (const s of parsed.sections) {
        if (!s || typeof s !== "object") continue;
        const slug = (s.slug || slugFromFilename(s.name || s.path?.split("/").pop() || "section"));
        if (slug && s.path) sections[slug] = s.path;
      }
    }

    if (Object.keys(sections).length === 0 && Array.isArray(parsed.mappings)) {
      for (const m of parsed.mappings) {
        if (!m?.local) continue;
        const slug = m.section || slugFromFilename(m.local.split("/").pop() || "default") || "default";
        sections[slug] = m.local;
      }
    }

    if (Object.keys(sections).length === 0) {
      sections.default = parsed.root && typeof parsed.root === "string" ? parsed.root : ".";
    }

    const next: Record<string, any> = {
      space: parsed.space,
      api: parsed.api,
    };
    if (parsed.name) next.name = parsed.name;
    next.sections = sections;
    if (Array.isArray(parsed.ignore) && parsed.ignore.length > 0) next.ignore = parsed.ignore;

    const newYaml = stringifyYaml(next);
    console.log(`Rewriting ${configPath} to:\n`);
    console.log(newYaml.split("\n").map(l => `  ${l}`).join("\n"));

    writeFileSync(configPath, newYaml);
    console.log("\nDone. Sync state in .sideways/sync.json may need to be repopulated on next pull.");
  });

program
  .command("keys")
  .description("List API keys")
  .action(async () => {
    const config = findConfig();
    const client = createClient(config?.api || getStoredCredentials()?.api_url || "http://localhost:4100");
    const keys = await client.listKeys();
    if (keys.length === 0) {
      console.log("No API keys.");
      return;
    }
    for (const k of keys) {
      console.log(`  ${k.prefix}... — ${k.name || "(unnamed)"} — created ${new Date(k.createdAt).toLocaleDateString()}`);
    }
  });

// ── themes ────────────────────────────────────────────────────────────

program
  .command("themes")
  .description("List print themes")
  .action(async () => {
    const config = findConfig();
    const client = createClient(config?.api || getStoredCredentials()?.api_url || "http://localhost:4100");
    const themes = await client.listThemes();
    if (themes.length === 0) {
      console.log("No themes.");
      return;
    }
    const nameWidth = Math.max(...themes.map((t: { name: string }) => t.name.length));
    for (const t of themes) {
      console.log(`  ${t.name.padEnd(nameWidth)}  ${t.id}`);
    }
  });

program.parseAsync().catch((err) => {
  console.error(err?.message ?? String(err));
  process.exit(1);
});
