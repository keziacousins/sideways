#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, resolve, join } from "node:path";
import { findConfig, createConfig, requireConfig } from "./config.js";
import { resolveSyncTargets } from "./mappings.js";
import { createClient } from "./api.js";
import { login, clearCredentials, getStoredCredentials, storeCredentials } from "./auth.js";
import { embedComments, extractComments, type SerializedComment } from "@sideways/markdown";
import {
  readSyncState,
  writeSyncState,
  hashLocalFile,
  slugFromFilename,
  titleFromSlug,
  parseFrontmatter,
  serializeFrontmatter,
  computeDiff,
} from "./sync.js";

const program = new Command();

program
  .name("sideways")
  .description("Sideways CLI — push, pull, and manage documentation")
  .version("0.0.1");

// ── init ──────────────────────────────────────────────────────────────

program
  .command("init <space>")
  .description("Create .sideways.yml in the current directory")
  .option("--api <url>", "API base URL", "http://localhost:4100")
  .action((space: string, opts: { api: string }) => {
    const path = createConfig(process.cwd(), space, opts.api);
    console.log(`Created ${path}`);
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
      opts: {
        space?: string;
        clean?: boolean;
        includeResolved?: boolean;
        force?: boolean;
      },
    ) => {
      const config = requireConfig();
      const space = opts.space ?? config.space;
      const client = createClient(config.api);
      const targets = resolveSyncTargets(config, path);

      let totalPulled = 0;
      let totalSkipped = 0;

      for (const target of targets) {
        const { localDir, section } = target;
        mkdirSync(localDir, { recursive: true });

        // Ensure section exists on remote if specified
        if (section) {
          await client.createSection(space, section).catch(() => {});
        }

        const remoteFiles = await client.getSyncInfo(space, section || undefined);
        const syncState = readSyncState(localDir, space, section);

        if (targets.length > 1) {
          const label = section || "(root)";
          console.log(`\n${label}:`);
        }

        for (const remote of remoteFiles) {
          const filename = `${remote.slug}.md`;
          const filePath = join(localDir, filename);
          const tracked = syncState.files[filename];

          if (tracked && !opts.force) {
            try {
              const localContent = readFileSync(filePath, "utf-8");
              const localHash = hashLocalFile(localContent);
              if (localHash !== tracked.localHash && remote.contentHash !== tracked.remoteHash) {
                console.log(`  conflict: ${filename} (use --force to overwrite)`);
                totalSkipped++;
                continue;
              }
            } catch {}
          }

          const doc = await client.getDocument(space, remote.slug);
          let content = doc.content;

          const fm: Record<string, any> = {};
          if (doc.title && doc.title !== titleFromSlug(remote.slug)) {
            fm.title = doc.title;
          }
          if (doc.tags?.length > 0) {
            fm.tags = doc.tags;
          }

          if (!opts.clean) {
            try {
              const rawComments = await client.getComments(
                space, remote.slug, opts.includeResolved,
              );
              if (rawComments.length > 0) {
                const serialized: SerializedComment[] = rawComments.map(
                  (c: any) => ({
                    id: c.id,
                    author: c.author?.name || "Unknown",
                    authorEmail: c.author?.email,
                    date: c.createdAt?.slice(0, 10) || "",
                    body: c.body,
                    anchorText: c.anchorText,
                    anchorSection: c.anchorSection,
                    anchorContext: c.anchorContext,
                    parentId: c.parentId,
                    resolved: c.resolved,
                  }),
                );
                content = embedComments(content, serialized);
              }
            } catch {}
          }

          const output = Object.keys(fm).length > 0
            ? serializeFrontmatter(fm, content)
            : content;

          writeFileSync(filePath, output);

          syncState.files[filename] = {
            slug: remote.slug,
            remoteVersion: remote.version,
            localHash: hashLocalFile(output),
            remoteHash: remote.contentHash,
          };

          const isNew = !tracked;
          console.log(`  ${isNew ? "new" : "updated"}: ${filename}`);
          totalPulled++;
        }

        syncState.lastSync = new Date().toISOString();
        writeSyncState(localDir, syncState);
      }

      console.log(`\nPulled ${totalPulled} file(s)${totalSkipped > 0 ? `, ${totalSkipped} skipped` : ""}`);
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
      const client = createClient(config.api);

      // If path is a single file, push just that
      if (path && path.endsWith(".md")) {
        const filePath = resolve(path);
        const raw = readFileSync(filePath, "utf-8");
        const { clean, comments: embeddedComments } = extractComments(raw);
        const { frontmatter, content } = parseFrontmatter(clean);

        const slug =
          frontmatter.slug ||
          slugFromFilename(basename(path));
        const title = frontmatter.title || titleFromSlug(slug);
        const tags = frontmatter.tags || [];

        if (opts.dryRun) {
          console.log(`  would push: ${slug} (${title})`);
          return;
        }

        const result = await client.putDocument(space, slug, {
          title,
          content,
          tags,
        });

        if (embeddedComments.length > 0) {
          console.log(`  ${embeddedComments.length} comment(s) extracted`);
        }

        console.log(`Pushed ${space}/${slug} (${result.id})`);
        return;
      }

      // Push all changed files across sync targets
      const targets = resolveSyncTargets(config, path?.endsWith(".md") ? undefined : path);

      // Ensure space exists on remote
      await client.createSpace(space).catch(() => {});

      let totalPushed = 0;
      for (const target of targets) {
        const { localDir, section } = target;

        if (section) {
          await client.createSection(space, section).catch(() => {});
        }

        const syncState = readSyncState(localDir, space, section);
        const remoteFiles = await client.getSyncInfo(space, section || undefined);

        const diffs = computeDiff(localDir, syncState, remoteFiles);
        const toPush = diffs.filter(
          (d) =>
            d.status === "new" ||
            d.status === "modified" ||
            (d.status === "conflict" && opts.force),
        );

        if (toPush.length === 0) continue;

        if (targets.length > 1) {
          console.log(`\n${section || "(root)"}:`);
        }

        for (const diff of toPush) {
          const filePath = join(localDir, diff.filename);

          if (opts.dryRun) {
            console.log(`  would push: ${diff.filename} (${diff.status})`);
            continue;
          }

          const raw = readFileSync(filePath, "utf-8");
          const { clean } = extractComments(raw);
          const { frontmatter, content } = parseFrontmatter(clean);

          const title = frontmatter.title || titleFromSlug(diff.slug);
          const tags = frontmatter.tags || [];

          await client.putDocument(space, diff.slug, { title, content, tags });

          const h = hashLocalFile(raw);
          syncState.files[diff.filename] = {
            slug: diff.slug,
            remoteVersion: (syncState.files[diff.filename]?.remoteVersion ?? 0) + 1,
            localHash: h,
            remoteHash: h,
          };

          console.log(`  pushed: ${diff.filename} (${diff.status})`);
          totalPushed++;
        }

        if (!opts.dryRun) {
          const conflicts = diffs.filter((d) => d.status === "conflict" && !opts.force);
          for (const c of conflicts) {
            console.log(`  conflict: ${c.filename} (use --force to overwrite)`);
          }

          const updatedRemote = await client.getSyncInfo(space, section || undefined);
          const remoteHashMap = new Map(updatedRemote.map((r: any) => [r.slug, r]));
          for (const entry of Object.values(syncState.files)) {
            const remote = remoteHashMap.get(entry.slug);
            if (remote) {
              entry.remoteHash = remote.contentHash;
              entry.remoteVersion = remote.version;
            }
          }

          syncState.lastSync = new Date().toISOString();
          writeSyncState(localDir, syncState);
        }
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
  .description("Show sync status — what's changed locally vs remote")
  .option("--space <space>", "Override space from config")
  .action(async (opts: { space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = createClient(config.api);
    const targets = resolveSyncTargets(config);

    let anyFiles = false;
    for (const target of targets) {
      const { localDir, section } = target;
      const syncState = readSyncState(localDir, space, section);
      const remoteFiles = await client.getSyncInfo(space, section || undefined);
      const diffs = computeDiff(localDir, syncState, remoteFiles);

      if (diffs.length === 0) continue;
      anyFiles = true;

      const label = section ? `${space}/${section}` : space;
      console.log(`${label}:`);
      const show = (status: string, d: { filename: string; slug: string }) => {
        const slugPart = d.slug !== d.filename.replace(/\.md$/, "") ? ` → ${d.slug}` : "";
        console.log(`  ${status.padEnd(10)}  ${d.filename}${slugPart}`);
      };
      for (const d of diffs.filter((d) => d.status === "conflict")) show("conflict", d);
      for (const d of diffs.filter((d) => d.status === "modified")) show("modified", d);
      for (const d of diffs.filter((d) => d.status === "new")) show("new", d);
      for (const d of diffs.filter((d) => d.status === "deleted")) show("deleted", d);
      for (const d of diffs.filter((d) => d.status === "unchanged")) show("unchanged", d);
    }

    if (!anyFiles) {
      console.log("No files tracked. Run `sideways pull` first.");
    }
  });

// ── diff ──────────────────────────────────────────────────────────────

program
  .command("diff <file>")
  .description("Show diff between local file and remote version")
  .option("--space <space>", "Override space from config")
  .action(async (file: string, opts: { space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = createClient(config.api);

    const filePath = resolve(file);
    const raw = readFileSync(filePath, "utf-8");
    const { clean } = extractComments(raw);
    const { frontmatter, content: localContent } = parseFrontmatter(clean);

    const slug = frontmatter.slug || slugFromFilename(basename(file));

    let remoteContent: string;
    try {
      const doc = await client.getDocument(space, slug);
      remoteContent = doc.content;
    } catch {
      console.log(`No remote document found for slug "${slug}"`);
      console.log("This file would be created as a new document on push.");
      return;
    }

    const localLines = localContent.trim().split("\n");
    const remoteLines = remoteContent.trim().split("\n");

    if (localContent.trim() === remoteContent.trim()) {
      console.log(`${file} ↔ ${space}/${slug}: no changes`);
      return;
    }

    console.log(`--- remote: ${space}/${slug}`);
    console.log(`+++ local:  ${file}`);
    console.log();

    // Simple line-by-line diff
    const maxLines = Math.max(localLines.length, remoteLines.length);
    for (let i = 0; i < maxLines; i++) {
      const remote = remoteLines[i];
      const local = localLines[i];
      if (remote === local) continue;
      if (remote === undefined) {
        console.log(`+${i + 1}: ${local}`);
      } else if (local === undefined) {
        console.log(`-${i + 1}: ${remote}`);
      } else {
        console.log(`-${i + 1}: ${remote}`);
        console.log(`+${i + 1}: ${local}`);
      }
    }
  });

// ── list ──────────────────────────────────────────────────────────────

program
  .command("list")
  .description("List documents in a space")
  .option("--space <space>", "Override space from config")
  .action(async (opts: { space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = createClient(config.api);

    const docs = await client.listDocuments(space);
    if (docs.length === 0) {
      console.log(`No documents in space "${space}"`);
      return;
    }
    for (const doc of docs) {
      const tags = doc.tags?.length ? ` [${doc.tags.join(", ")}]` : "";
      console.log(`  ${doc.slug}  ${doc.title}${tags}`);
    }
  });

// ── spaces ────────────────────────────────────────────────────────────

program
  .command("spaces")
  .description("List all spaces")
  .action(async () => {
    const config = findConfig() ?? { api: "http://localhost:4100", space: "", mappings: [], rootDir: "" };
    const client = createClient(config.api);

    const spaces = await client.listSpaces();
    if (spaces.length === 0) {
      console.log("No spaces yet");
      return;
    }
    for (const s of spaces) {
      const desc = s.description ? ` — ${s.description}` : "";
      console.log(`  ${s.slug}  ${s.name}${desc}  (${s.visibility})`);
    }
  });

// ── versions ──────────────────────────────────────────────────────────

program
  .command("versions <slug>")
  .description("List versions of a document")
  .option("--space <space>", "Override space from config")
  .action(async (slug: string, opts: { space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = createClient(config.api);

    const versions = await client.getVersions(space, slug);
    for (const v of versions) {
      const date = new Date(v.createdAt).toLocaleString();
      console.log(`  v${v.version}  ${v.contentHash}  ${date}`);
    }
  });

// ── login ─────────────────────────────────────────────────────────────

program
  .command("login")
  .description("Authenticate with an API key")
  .option("--key <key>", "API key (sk-...) — skips interactive prompt")
  .action(async (opts: { key?: string }) => {
    const config = findConfig() ?? { api: "http://localhost:4100", space: "", mappings: [], rootDir: "" };

    if (opts.key) {
      // Non-interactive: validate and store
      if (!opts.key.startsWith("sk-")) {
        console.error("Invalid API key. Keys start with 'sk-'.");
        process.exit(1);
      }
      try {
        const res = await fetch(`${config.api}/api/auth/me`, {
          headers: { Authorization: `Bearer ${opts.key}` },
        });
        if (!res.ok) {
          console.error("API key is invalid or expired.");
          process.exit(1);
        }
        const user = await res.json();
        storeCredentials({ api_key: opts.key, api_url: config.api });
        console.log(`Authenticated as ${user.name} (${user.email})`);
      } catch {
        console.error("Could not connect to the API server.");
        process.exit(1);
      }
      return;
    }

    // Interactive
    try {
      await login(config.api);
    } catch (err: any) {
      console.error(`Login failed: ${err.message}`);
      process.exit(1);
    }
  });

// ── logout ────────────────────────────────────────────────────────────

program
  .command("logout")
  .description("Clear stored API key")
  .action(() => {
    clearCredentials();
    console.log("Logged out. API key cleared.");
  });

// ── whoami ────────────────────────────────────────────────────────────

program
  .command("whoami")
  .description("Show current authentication status")
  .action(() => {
    const creds = getStoredCredentials();
    if (!creds?.api_key) {
      console.log("Not logged in. Run `sideways login` to authenticate.");
      return;
    }
    console.log(`Authenticated with API key: ${creds.api_key.slice(0, 11)}...`);
    console.log(`API: ${creds.api_url}`);
  });

// ── keys ──────────────────────────────────────────────────────────────

program
  .command("keys")
  .description("List your API keys")
  .action(async () => {
    const config = findConfig() ?? { api: "http://localhost:4100", space: "", mappings: [], rootDir: "" };
    const client = createClient(config.api);

    try {
      const keys = await client.listKeys();
      if (keys.length === 0) {
        console.log("No API keys.");
        return;
      }
      for (const k of keys) {
        const lastUsed = k.lastUsedAt
          ? new Date(k.lastUsedAt).toLocaleDateString()
          : "never";
        console.log(`  ${k.prefix}...  ${k.name}  (last used: ${lastUsed})`);
      }
    } catch (err: any) {
      console.error(`Failed to list keys: ${err.message}`);
    }
  });

program.parse();
