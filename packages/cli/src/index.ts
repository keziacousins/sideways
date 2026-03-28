#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { basename, resolve, join, relative } from "node:path";
import { findConfig, createConfig, requireConfig } from "./config.js";
import { createClient } from "./api.js";
import { login, clearCredentials, getStoredCredentials, storeCredentials } from "./auth.js";
import { requireSpace, ensureSpace } from "./preflight.js";
import { embedComments, extractComments, type SerializedComment } from "@sideways/markdown";
import {
  readSyncState,
  writeSyncState,
  hashLocalFile,
  slugFromFilename,
  titleFromSlug,
  parseFrontmatter,
  serializeFrontmatter,
  discoverFiles,
} from "./sync.js";

const program = new Command();

program
  .name("sideways")
  .description("Sideways CLI — push, pull, and manage documentation")
  .version(process.env.SIDEWAYS_VERSION || "dev")
  .option("--as <name>", "Act as a named agent (e.g. --as Claude)");

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
    // Use: explicit --api > stored credentials URL > default
    const creds = getStoredCredentials();
    const api = opts.api || creds?.api_url || "http://localhost:4100";
    const path = createConfig(process.cwd(), slug, api, space);
    console.log(`Created ${path}`);
  });

// ── Shared helpers ────────────────────────────────────────────────────

function getSyncRoot(config: ReturnType<typeof requireConfig>): string {
  return resolve(config.rootDir, config.root || ".");
}

function getClient(apiUrl: string) {
  const actorName = program.opts().as;
  return createClient(apiUrl, actorName);
}

/** Resolve a user-provided identifier (slug, filename, or path) to a discovered file */
function resolveFile(files: ReturnType<typeof discoverFiles>, input: string) {
  const normalized = slugFromFilename(basename(input));
  return files.find(f => f.slug === input || f.slug === normalized || f.relativePath === input || f.filename === input);
}

/** Normalize user input to a slug — accepts filenames, paths, or slugs */
function toSlug(input: string): string {
  return slugFromFilename(basename(input));
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
  if (doc.title && doc.title !== titleFromSlug(doc.slug) && doc.title !== headingTitle) {
    fm.title = doc.title;
  }
  if (doc.tags?.length > 0) fm.tags = doc.tags;

  if (!opts.clean) {
    try {
      const rawComments = await client.getComments(space, doc.slug, opts.includeResolved);
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
function prepareFileForPush(filePath: string): { slug: string; content: string; tags: string[]; title?: string } {
  const raw = readFileSync(filePath, "utf-8");
  const { clean } = extractComments(raw);
  const { frontmatter, content } = parseFrontmatter(clean);
  const slug = frontmatter.slug || slugFromFilename(basename(filePath));
  const tags = frontmatter.tags || [];
  return { slug, content, tags, title: frontmatter.title };
}

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
      const syncRoot = getSyncRoot(config);

      await requireSpace(client, space, { createHint: true });

      // Single file pull
      if (path && (path.endsWith(".md") || !path.includes("/"))) {
        const slug = slugFromFilename(basename(path));
        const doc = await client.getDocument(space, slug);
        const output = await prepareFileForDisk(client, space, doc, opts);
        const filePath = resolve(path.endsWith(".md") ? path : `${path}.md`);

        writeFileSync(filePath, output);

        const syncInfo = await client.getSyncInfo(space).catch(() => []);
        const remote = syncInfo.find((r: any) => r.slug === slug);
        if (remote) {
          const syncState = readSyncState(syncRoot, space);
          const relPath = relative(syncRoot, filePath);
          syncState.files[relPath] = {
            slug,
            remoteVersion: remote.version,
            localHash: hashLocalFile(output),
            remoteHash: remote.contentHash,
          };
          syncState.lastSync = new Date().toISOString();
          writeSyncState(syncRoot, syncState);
        }

        console.log(`Pulled ${space}/${slug} → ${filePath}`);
        return;
      }

      // Full pull — fetch all docs, recreate directory structure
      mkdirSync(syncRoot, { recursive: true });

      const [allDocs, syncInfo] = await Promise.all([
        client.listDocuments(space),
        client.getSyncInfo(space),
      ]);

      let sections: { id: string; slug: string }[] = [];
      try { sections = await client.listSections(space); } catch {}

      const sectionSlugById = new Map(sections.map((s: any) => [s.id, s.slug]));
      const docSlugById = new Map(allDocs.map((d: any) => [d.id, d.slug]));
      const remoteHashMap = new Map(syncInfo.map((r: any) => [r.slug, r]));
      const hasChildrenSet = new Set(allDocs.filter((d: any) => d.parentId).map((d: any) => d.parentId));

      const syncState = readSyncState(syncRoot, space);
      let totalPulled = 0;
      let totalSkipped = 0;

      /** Build filesystem path for a doc based on its section + parent hierarchy */
      function buildDocPath(doc: any): string {
        const parts: string[] = [];

        // Walk parent chain
        const parentChain: string[] = [];
        let currentParentId = doc.parentId;
        const visited = new Set<string>();
        while (currentParentId && !visited.has(currentParentId)) {
          visited.add(currentParentId);
          const parentSlug = docSlugById.get(currentParentId);
          if (parentSlug) parentChain.unshift(parentSlug);
          const parentDoc = allDocs.find((d: any) => d.id === currentParentId);
          currentParentId = parentDoc?.parentId ?? null;
        }

        // Section directory (only for docs without parents)
        if (!doc.parentId && doc.sectionId) {
          const sectionSlug = sectionSlugById.get(doc.sectionId);
          if (sectionSlug) parts.push(sectionSlug);
        } else if (doc.parentId && parentChain.length > 0) {
          // Find root parent's section
          let rootParentId = doc.parentId;
          const rootVisited = new Set<string>();
          while (rootParentId && !rootVisited.has(rootParentId)) {
            rootVisited.add(rootParentId);
            const p = allDocs.find((d: any) => d.id === rootParentId);
            if (!p?.parentId) break;
            rootParentId = p.parentId;
          }
          const rootParent = allDocs.find((d: any) => d.id === rootParentId);
          if (rootParent?.sectionId) {
            const secSlug = sectionSlugById.get(rootParent.sectionId);
            if (secSlug && secSlug !== parentChain[0]) {
              parts.push(secSlug);
            }
          }
        }

        parts.push(...parentChain);

        const hasChildren = hasChildrenSet.has(doc.id);
        const sectionSlug = doc.sectionId ? sectionSlugById.get(doc.sectionId) : null;
        const isSectionIndex = sectionSlug && doc.slug === sectionSlug && !doc.parentId;

        if (isSectionIndex) {
          return parts.length > 0 ? join(...parts, "index.md") : "index.md";
        }
        if (hasChildren) {
          parts.push(doc.slug);
          return parts.length > 0 ? join(...parts, "index.md") : "index.md";
        }

        return parts.length > 0 ? join(...parts, `${doc.slug}.md`) : `${doc.slug}.md`;
      }

      for (const doc of allDocs) {
        const relativePath = buildDocPath(doc);
        const filePath = join(syncRoot, relativePath);
        const tracked = syncState.files[relativePath];
        const remote = remoteHashMap.get(doc.slug);

        // Conflict check
        if (tracked && !opts.force) {
          try {
            const localContent = readFileSync(filePath, "utf-8");
            const localHash = hashLocalFile(localContent);
            if (localHash !== tracked.localHash && remote && remote.contentHash !== tracked.remoteHash) {
              console.log(`  conflict: ${relativePath} (use --force to overwrite)`);
              totalSkipped++;
              continue;
            }
          } catch {}
        }

        const fullDoc = await client.getDocument(space, doc.slug);
        const output = await prepareFileForDisk(client, space, fullDoc, opts);

        mkdirSync(join(filePath, ".."), { recursive: true });
        writeFileSync(filePath, output);

        syncState.files[relativePath] = {
          slug: doc.slug,
          remoteVersion: remote?.version ?? 1,
          localHash: hashLocalFile(output),
          remoteHash: remote?.contentHash ?? hashLocalFile(output),
        };

        const isNew = !tracked;
        console.log(`  ${isNew ? "new" : "updated"}: ${relativePath}`);
        totalPulled++;
      }

      syncState.lastSync = new Date().toISOString();
      writeSyncState(syncRoot, syncState);

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
      const syncRoot = getSyncRoot(config);

      if (!opts.dryRun) {
        await ensureSpace(client, space, config.spaceName || undefined);
      }

      // Discover all files from the sync root
      const allFiles = discoverFiles(syncRoot, config.ignore);

      // If path targets a single file, filter to just that
      let files = allFiles;
      if (path && path.endsWith(".md")) {
        const absPath = resolve(path);
        const relPath = relative(syncRoot, absPath);
        files = allFiles.filter(f => f.relativePath === relPath);
        if (files.length === 0) {
          // File not in sync root — push as standalone
          const { slug, content, tags, title } = prepareFileForPush(absPath);
          if (opts.dryRun) {
            console.log(`  would push: ${slug}`);
            return;
          }
          const body: Record<string, any> = { content, tags };
          if (title) body.title = title;
          const result = await client.putDocument(space, slug, body);
          console.log(`Pushed ${space}/${slug} (${result.id})`);
          return;
        }
      }

      // Create sections for all first-level directories
      const sectionSlugs = new Set(files.map(f => f.section).filter(Boolean) as string[]);
      if (!opts.dryRun) {
        for (const section of sectionSlugs) {
          await client.createSection(space, section).catch(() => {});
        }
      }

      // Get remote state for diff
      const remoteFiles = await client.getSyncInfo(space);
      const remoteMap = new Map(remoteFiles.map((r: any) => [r.slug, r]));
      const syncState = readSyncState(syncRoot, space);

      let totalPushed = 0;

      // Push parents before children
      const sorted = [...files].sort((a, b) => a.depth - b.depth);

      for (const file of sorted) {
        const filePath = join(syncRoot, file.relativePath);
        const raw = readFileSync(filePath, "utf-8");
        const localHash = hashLocalFile(raw);
        const tracked = syncState.files[file.relativePath];
        const remote = remoteMap.get(file.slug);

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

        if (status === "unchanged" || status === "remote-modified") continue;
        if (status === "conflict" && !opts.force) {
          console.log(`  conflict: ${file.relativePath} (use --force to overwrite)`);
          continue;
        }

        if (opts.dryRun) {
          console.log(`  would push: ${file.relativePath} → ${file.slug} (${status})`);
          totalPushed++;
          continue;
        }

        const { clean } = extractComments(raw);
        const { frontmatter, content } = parseFrontmatter(clean);
        const tags = frontmatter.tags || [];
        const body: Record<string, any> = { content, tags };
        if (frontmatter.title) body.title = frontmatter.title;
        if (file.section) body.sectionSlug = file.section;
        if (file.parentSlug) body.parentSlug = file.parentSlug;
        // Preserve local file timestamp so mtime-based fallback works
        body.updatedAt = statSync(filePath).mtime.toISOString();

        await client.putDocument(space, file.slug, body);

        syncState.files[file.relativePath] = {
          slug: file.slug,
          remoteVersion: (tracked?.remoteVersion ?? 0) + 1,
          localHash,
          remoteHash: localHash,
        };

        console.log(`  pushed: ${file.relativePath} → ${file.slug} (${status})`);
        totalPushed++;
      }

      if (!opts.dryRun) {
        // Refresh remote state and ensure ALL local files are tracked
        const updatedRemote = await client.getSyncInfo(space);
        const remoteHashMap = new Map(updatedRemote.map((r: any) => [r.slug, r]));

        for (const file of sorted) {
          const remote = remoteHashMap.get(file.slug);
          if (!remote) continue;

          if (syncState.files[file.relativePath]) {
            // Already tracked — update remote hash/version
            syncState.files[file.relativePath].remoteHash = remote.contentHash;
            syncState.files[file.relativePath].remoteVersion = remote.version;
          } else {
            // Not tracked yet — record it now
            const filePath = join(syncRoot, file.relativePath);
            const raw = readFileSync(filePath, "utf-8");
            syncState.files[file.relativePath] = {
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
    const syncRoot = getSyncRoot(config);

    await requireSpace(client, space);

    const files = discoverFiles(syncRoot, config.ignore);
    const remoteFiles = await client.getSyncInfo(space);
    const remoteMap = new Map(remoteFiles.map((r: any) => [r.slug, r]));
    const syncState = readSyncState(syncRoot, space);

    const sorted = [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    function show(label: string, file: { relativePath: string; slug: string }) {
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
      console.log(`  ${color}${label.padEnd(16)}${reset} ${file.relativePath}`);
    }

    let hasChanges = false;
    for (const file of sorted) {
      const filePath = join(syncRoot, file.relativePath);
      const raw = readFileSync(filePath, "utf-8");
      const localHash = hashLocalFile(raw);
      const tracked = syncState.files[file.relativePath];
      const remote = remoteMap.get(file.slug);

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

    // Check for remote-only files
    const localSlugs = new Set(files.map(f => f.slug));
    for (const remote of remoteFiles) {
      if (!localSlugs.has(remote.slug)) {
        show("new-remote", { relativePath: `${remote.slug}.md`, slug: remote.slug });
        hasChanges = true;
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
    const syncRoot = getSyncRoot(config);

    if (!opts.dryRun) {
      await ensureSpace(client, space, config.spaceName || undefined);
    }

    const allFiles = discoverFiles(syncRoot, config.ignore);
    const remoteFiles = await client.getSyncInfo(space);
    const remoteMap = new Map(remoteFiles.map((r: any) => [r.slug, r]));
    const syncState = readSyncState(syncRoot, space);

    // Classify all files
    const toPull: { slug: string; relativePath: string }[] = [];
    const toPush: { file: (typeof allFiles)[0]; raw: string }[] = [];
    const conflicts: string[] = [];
    const localSlugs = new Set<string>();

    for (const file of allFiles) {
      localSlugs.add(file.slug);
      const filePath = join(syncRoot, file.relativePath);
      const raw = readFileSync(filePath, "utf-8");
      const localHash = hashLocalFile(raw);
      const tracked = syncState.files[file.relativePath];
      const remote = remoteMap.get(file.slug);

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
        const remoteDoc = await client.getDocument(space, file.slug);
        const { clean: localClean } = extractComments(raw);
        const { content: localContent } = parseFrontmatter(localClean);
        if (localContent.trim() === remoteDoc.content.trim()) {
          console.log(`  \x1b[2mreconciled\x1b[0m  ${file.relativePath}`);
          syncState.files[file.relativePath] = {
            slug: file.slug,
            remoteVersion: remote.version,
            localHash,
            remoteHash: remote.contentHash,
          };
          // Update remote timestamp to match local
          const localMtime = statSync(filePath).mtime.toISOString();
          await client.putDocument(space, file.slug, { updatedAt: localMtime });
          continue;
        }
      }

      if (status === "unchanged") {
        // Ensure sync state is recorded even for unchanged files
        if (!tracked && remote) {
          syncState.files[file.relativePath] = {
            slug: file.slug,
            remoteVersion: remote.version,
            localHash,
            remoteHash: remote.contentHash,
          };
        }
        continue;
      }
      if (status === "conflict") { conflicts.push(file.relativePath); continue; }
      if (status === "remote-modified") { toPull.push({ slug: file.slug, relativePath: file.relativePath }); continue; }
      if (status === "new-local" || status === "local-modified") { toPush.push({ file, raw }); }
    }

    // Check for remote-only files (new on remote)
    for (const remote of remoteFiles) {
      if (!localSlugs.has(remote.slug)) {
        toPull.push({ slug: remote.slug, relativePath: `${remote.slug}.md` });
      }
    }

    if (toPull.length === 0 && toPush.length === 0 && conflicts.length === 0) {
      console.log("Everything up to date.");
      return;
    }

    // Pull remote changes
    if (toPull.length > 0) {
      console.log(`\nPulling ${toPull.length} file(s):`);
      for (const { slug, relativePath } of toPull) {
        if (opts.dryRun) {
          console.log(`  would pull: ${relativePath}`);
          continue;
        }
        const doc = await client.getDocument(space, slug);
        const output = await prepareFileForDisk(client, space, doc, { clean: opts.clean });
        const filePath = join(syncRoot, relativePath);
        mkdirSync(join(filePath, ".."), { recursive: true });
        writeFileSync(filePath, output);

        const remoteInfo = remoteMap.get(slug);
        syncState.files[relativePath] = {
          slug,
          remoteVersion: remoteInfo?.version ?? 1,
          localHash: hashLocalFile(output),
          remoteHash: remoteInfo?.contentHash ?? hashLocalFile(output),
        };
        console.log(`  pulled: ${relativePath}`);
      }
    }

    // Push local changes
    if (toPush.length > 0) {
      // Create sections
      if (!opts.dryRun) {
        const sectionSlugs = new Set(toPush.map(p => p.file.section).filter(Boolean) as string[]);
        for (const section of sectionSlugs) {
          await client.createSection(space, section).catch(() => {});
        }
      }

      console.log(`\nPushing ${toPush.length} file(s):`);
      const sorted = [...toPush].sort((a, b) => a.file.depth - b.file.depth);
      for (const { file, raw } of sorted) {
        if (opts.dryRun) {
          console.log(`  would push: ${file.relativePath}`);
          continue;
        }
        const { clean } = extractComments(raw);
        const { frontmatter, content } = parseFrontmatter(clean);
        const tags = frontmatter.tags || [];
        const body: Record<string, any> = { content, tags };
        if (frontmatter.title) body.title = frontmatter.title;
        if (file.section) body.sectionSlug = file.section;
        if (file.parentSlug) body.parentSlug = file.parentSlug;
        body.updatedAt = statSync(join(syncRoot, file.relativePath)).mtime.toISOString();

        await client.putDocument(space, file.slug, body);

        const localHash = hashLocalFile(raw);
        syncState.files[file.relativePath] = {
          slug: file.slug,
          remoteVersion: (syncState.files[file.relativePath]?.remoteVersion ?? 0) + 1,
          localHash,
          remoteHash: localHash,
        };
        console.log(`  pushed: ${file.relativePath}`);
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
      const remoteHashMap = new Map(updatedRemote.map((r: any) => [r.slug, r]));
      for (const entry of Object.values(syncState.files)) {
        const remote = remoteHashMap.get(entry.slug);
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
  .command("diff [slug]")
  .description("Show content differences between local and remote")
  .option("--space <space>", "Override space from config")
  .action(async (slug: string | undefined, opts: { space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);
    const syncRoot = getSyncRoot(config);

    if (!slug) {
      console.error("Usage: sideways diff <slug>");
      process.exit(1);
    }

    const files = discoverFiles(syncRoot, config.ignore);
    const file = resolveFile(files, slug);
    if (!file) {
      console.error(`No local file found for "${slug}"`);
      process.exit(1);
    }

    const filePath = join(syncRoot, file.relativePath);
    const raw = readFileSync(filePath, "utf-8");
    const { clean } = extractComments(raw);
    const { content: localContent } = parseFrontmatter(clean);

    try {
      const doc = await client.getDocument(space, file.slug);
      const remoteContent = doc.content;

      if (localContent.trim() === remoteContent.trim()) {
        console.log("No content differences.");
        return;
      }

      const localLines = localContent.split("\n");
      const remoteLines = remoteContent.split("\n");

      console.log(`--- remote: ${space}/${slug}`);
      console.log(`+++ local: ${file.relativePath}`);

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
  .command("rename <slug> <new-title>")
  .description("Rename a document's title")
  .option("--space <space>", "Override space from config")
  .option("--slug <new-slug>", "Also change the slug")
  .action(async (input: string, newTitle: string, opts: { space?: string; slug?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);
    const slug = toSlug(input);

    const patch: Record<string, any> = { title: newTitle };
    if (opts.slug) patch.slug = opts.slug;

    const result = await client.patchDocument(space, slug, patch);
    console.log(`Renamed → "${result.title}" (${result.slug})`);
  });

// ── move ──────────────────────────────────────────────────────────────

program
  .command("move <slug> <target-space>")
  .description("Move a document to another space")
  .option("--space <space>", "Override source space from config")
  .action(async (input: string, targetSpace: string, opts: { space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);
    const slug = toSlug(input);

    const result = await client.patchDocument(space, slug, { space: targetSpace });
    console.log(`Moved ${slug} → ${targetSpace}/${result.slug}`);
  });

// ── duplicate ─────────────────────────────────────────────────────────

program
  .command("duplicate <slug>")
  .description("Duplicate a document")
  .option("--space <space>", "Override space from config")
  .option("--target-space <space>", "Target space for the copy")
  .option("--slug <slug>", "Custom slug for the copy")
  .action(async (input: string, opts: { space?: string; targetSpace?: string; slug?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);
    const slug = toSlug(input);

    const result = await client.duplicateDocument(space, slug, {
      targetSpace: opts.targetSpace,
      targetSlug: opts.slug,
    });
    console.log(`Duplicated → ${result.slug}`);
  });

// ── delete ────────────────────────────────────────────────────────────

program
  .command("delete <slug>")
  .description("Delete a document from the server")
  .option("--space <space>", "Override space from config")
  .action(async (input: string, opts: { space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);
    const slug = toSlug(input);

    await requireSpace(client, space);
    await client.deleteDocument(space, slug);
    console.log(`Deleted ${space}/${slug}`);
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
    console.log(`Updated ${field} → "${result[field]}"`);
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

// ── comments ──────────────────────────────────────────────────────────

program
  .command("comments <slug>")
  .description("List comments on a document")
  .option("--space <space>", "Override space from config")
  .option("--resolved", "Include resolved comments")
  .action(async (input: string, opts: { space?: string; resolved?: boolean }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);
    const slug = toSlug(input);

    const comments = await client.getComments(space, slug, opts.resolved);
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
  .command("comment <slug> <body>")
  .description("Add a comment to a document")
  .option("--space <space>", "Override space from config")
  .option("--anchor <text>", "Anchor comment to specific text in the document")
  .option("--section <path>", "Section heading path for the anchor")
  .option("--reply <id>", "Reply to an existing comment")
  .action(async (input: string, body: string, opts: { space?: string; anchor?: string; section?: string; reply?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);
    const slug = toSlug(input);

    const payload: Record<string, any> = { body };
    if (opts.anchor) payload.anchorText = opts.anchor;
    if (opts.section) payload.anchorSection = opts.section;
    if (opts.reply) payload.parentId = opts.reply;

    const result = await client.addComment(space, slug, payload as any);
    console.log(`Comment added (${result.id.slice(0, 8)})`);
  });

program
  .command("resolve <slug> <comment-id>")
  .description("Toggle resolve/reopen on a comment")
  .option("--space <space>", "Override space from config")
  .action(async (input: string, commentId: string, opts: { space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);
    const slug = toSlug(input);

    const result = await client.resolveComment(space, slug, commentId);
    console.log(`Comment ${result.resolved ? "resolved" : "reopened"}`);
  });

// ── export ────────────────────────────────────────────────────────────

program
  .command("export <slug>")
  .description("Export a document as PDF")
  .option("--space <space>", "Override space from config")
  .option("-o, --output <path>", "Output file path")
  .option("--no-toc", "Omit table of contents")
  .option("--no-title-page", "Omit title page")
  .action(async (input: string, opts: { space?: string; output?: string; toc?: boolean; titlePage?: boolean }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = getClient(config.api);
    const slug = toSlug(input);

    const res = await client.downloadPdf(space, slug, {
      toc: opts.toc,
      titlePage: opts.titlePage,
    });

    const outPath = opts.output || `${slug}.pdf`;
    const buffer = Buffer.from(await res.arrayBuffer());
    writeFileSync(outPath, buffer);
    console.log(`Exported ${space}/${slug} → ${outPath} (${buffer.length} bytes)`);
  });

// ── auth ──────────────────────────────────────────────────────────────

program
  .command("login")
  .description("Log in with an API key")
  .option("--api <url>", "API base URL")
  .action(async (opts: { api?: string }) => {
    const config = findConfig();
    const api = opts.api || config?.api || "http://localhost:4100";
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

program
  .command("keys")
  .description("List API keys")
  .action(async () => {
    const config = findConfig();
    const client = createClient(config?.api || "http://localhost:4100");
    const keys = await client.listKeys();
    if (keys.length === 0) {
      console.log("No API keys.");
      return;
    }
    for (const k of keys) {
      console.log(`  ${k.prefix}... — ${k.name || "(unnamed)"} — created ${new Date(k.createdAt).toLocaleDateString()}`);
    }
  });

program.parse();
