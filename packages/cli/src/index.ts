#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, resolve, join } from "node:path";
import { findConfig, createConfig, requireConfig, findMappingForCwd } from "./config.js";
import { createClient } from "./api.js";
import { login, clearCredentials, getStoredCredentials } from "./auth.js";
import { embedComments, extractComments, type SerializedComment } from "@sideways/markdown";
import {
  readSyncState,
  writeSyncState,
  hashContent,
  hashLocalFile,
  slugFromFilename,
  titleFromSlug,
  parseFrontmatter,
  serializeFrontmatter,
  findMarkdownFiles,
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
      const targetDir = resolve(path || ".");

      mkdirSync(targetDir, { recursive: true });

      // Get remote sync info
      const remoteFiles = await client.getSyncInfo(space);
      const syncState = readSyncState(targetDir, space);

      let pulled = 0;
      let skipped = 0;

      for (const remote of remoteFiles) {
        const filename = `${remote.slug}.md`;
        const filePath = join(targetDir, filename);
        const tracked = syncState.files[filename];

        // Check for local modifications
        if (tracked && !opts.force) {
          try {
            const localContent = readFileSync(filePath, "utf-8");
            const { content: stripped } = parseFrontmatter(localContent);
            const localHash = hashContent(stripped);
            if (localHash !== tracked.localHash && remote.contentHash !== tracked.remoteHash) {
              console.log(`  conflict: ${filename} (use --force to overwrite)`);
              skipped++;
              continue;
            }
          } catch {}
        }

        // Fetch full content
        const doc = await client.getDocument(space, remote.slug);
        let content = doc.content;

        // Add frontmatter if doc has tags or title differs from slug
        const fm: Record<string, any> = {};
        if (doc.title && doc.title !== titleFromSlug(remote.slug)) {
          fm.title = doc.title;
        }
        if (doc.tags?.length > 0) {
          fm.tags = doc.tags;
        }

        // Embed comments unless --clean
        if (!opts.clean) {
          try {
            const rawComments = await client.getComments(
              space,
              remote.slug,
              opts.includeResolved,
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

        // Update sync state — hash the file we just wrote through the same
        // pipeline that status will use (strip comments + frontmatter)
        syncState.files[filename] = {
          slug: remote.slug,
          remoteVersion: remote.version,
          localHash: hashLocalFile(output),
          remoteHash: remote.contentHash,
        };

        const isNew = !tracked;
        console.log(`  ${isNew ? "new" : "updated"}: ${filename}`);
        pulled++;
      }

      syncState.lastSync = new Date().toISOString();
      writeSyncState(targetDir, syncState);

      console.log(`\nPulled ${pulled} file(s)${skipped > 0 ? `, ${skipped} skipped` : ""}`);
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

      // Push all changed files in a directory
      const targetDir = resolve(path || ".");
      const syncState = readSyncState(targetDir, space);
      const remoteFiles = await client.getSyncInfo(space);

      const diffs = computeDiff(targetDir, syncState, remoteFiles);
      const toPush = diffs.filter(
        (d) =>
          d.status === "new" ||
          d.status === "modified" ||
          (d.status === "conflict" && opts.force),
      );

      if (toPush.length === 0) {
        console.log("Nothing to push.");
        return;
      }

      for (const diff of toPush) {
        const filePath = join(targetDir, diff.filename);

        if (opts.dryRun) {
          console.log(`  would push: ${diff.filename} (${diff.status})`);
          continue;
        }

        const raw = readFileSync(filePath, "utf-8");
        const { clean } = extractComments(raw);
        const { frontmatter, content } = parseFrontmatter(clean);

        const title = frontmatter.title || titleFromSlug(diff.slug);
        const tags = frontmatter.tags || [];

        const result = await client.putDocument(space, diff.slug, {
          title,
          content,
          tags,
        });

        // Update sync state — hash the file on disk through the same pipeline
        const fileOnDisk = readFileSync(filePath, "utf-8");
        const h = hashLocalFile(fileOnDisk);
        syncState.files[diff.filename] = {
          slug: diff.slug,
          remoteVersion: (syncState.files[diff.filename]?.remoteVersion ?? 0) + 1,
          localHash: h,
          remoteHash: h,
        };

        console.log(`  pushed: ${diff.filename} (${diff.status})`);
      }

      if (!opts.dryRun) {
        const conflicts = diffs.filter((d) => d.status === "conflict" && !opts.force);
        for (const c of conflicts) {
          console.log(`  conflict: ${c.filename} (use --force to overwrite)`);
        }

        // Re-fetch remote hashes after push to ensure sync state matches
        const updatedRemote = await client.getSyncInfo(space);
        const remoteHashMap = new Map(updatedRemote.map((r: any) => [r.slug, r]));
        for (const [filename, entry] of Object.entries(syncState.files)) {
          const remote = remoteHashMap.get(entry.slug);
          if (remote) {
            entry.remoteHash = remote.contentHash;
            entry.remoteVersion = remote.version;
          }
        }

        syncState.lastSync = new Date().toISOString();
        writeSyncState(targetDir, syncState);
        console.log(`\nPushed ${toPush.length} file(s)`);
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
    const targetDir = process.cwd();

    const syncState = readSyncState(targetDir, space);
    const remoteFiles = await client.getSyncInfo(space);
    const diffs = computeDiff(targetDir, syncState, remoteFiles);

    if (diffs.length === 0) {
      console.log("No files tracked. Run `sideways pull` first.");
      return;
    }

    const modified = diffs.filter((d) => d.status === "modified");
    const newFiles = diffs.filter((d) => d.status === "new");
    const deleted = diffs.filter((d) => d.status === "deleted");
    const conflicts = diffs.filter((d) => d.status === "conflict");
    const unchanged = diffs.filter((d) => d.status === "unchanged");

    console.log(`${space}:`);
    for (const d of conflicts) console.log(`  conflict:   ${d.filename}`);
    for (const d of modified) console.log(`  modified:   ${d.filename}`);
    for (const d of newFiles) console.log(`  new:        ${d.filename}`);
    for (const d of deleted) console.log(`  deleted:    ${d.filename}`);
    for (const d of unchanged) console.log(`  unchanged:  ${d.filename}`);
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
  .description("Authenticate with the Sideways server")
  .option("--hydra <url>", "Hydra public URL", "http://localhost:4444")
  .action(async (opts: { hydra: string }) => {
    const config = findConfig() ?? { api: "http://localhost:4100", space: "", mappings: [], rootDir: "" };
    try {
      await login(opts.hydra, config.api);
      console.log("Logged in successfully.");
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
