#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { basename, resolve, join } from "node:path";
import { findConfig, createConfig, requireConfig } from "./config.js";
import { resolveSyncTargets } from "./mappings.js";
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
    const slug = slugFromFilename(space);
    if (slug !== space) {
      console.log(`Slugified: "${space}" → "${slug}"`);
    }
    const path = createConfig(process.cwd(), slug, opts.api, space);
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

      await requireSpace(client, space, { createHint: true });

      let totalPulled = 0;
      let totalSkipped = 0;

      for (const target of targets) {
        const { localDir, section } = target;
        mkdirSync(localDir, { recursive: true });

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
        const tags = frontmatter.tags || [];

        if (opts.dryRun) {
          console.log(`  would push: ${slug}`);
          return;
        }

        const body: Record<string, any> = { content, tags };
        if (frontmatter.title) body.title = frontmatter.title;

        const result = await client.putDocument(space, slug, body as any);

        console.log(`Pushed ${space}/${slug} (${result.id})`);
        return;
      }

      // Push all changed files across sync targets
      const targets = resolveSyncTargets(config, path?.endsWith(".md") ? undefined : path);

      await ensureSpace(client, space, config.spaceName || undefined);

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
            d.status === "new-local" ||
            d.status === "local-modified" ||
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

          const tags = frontmatter.tags || [];
          const body: Record<string, any> = { content, tags };
          // Only send title if explicitly set in frontmatter — otherwise let
          // the server extract it from the first # heading
          if (frontmatter.title) body.title = frontmatter.title;

          await client.putDocument(space, diff.slug, body);

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

    await requireSpace(client, space, { createHint: true });

    let anyFiles = false;
    for (const target of targets) {
      const { localDir, section } = target;
      const remoteFiles = await client.getSyncInfo(space, section || undefined);
      const syncState = readSyncState(localDir, space, section);
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
      for (const d of diffs.filter((d) => d.status === "local-modified")) show("modified→", d);
      for (const d of diffs.filter((d) => d.status === "remote-modified")) show("←modified", d);
      for (const d of diffs.filter((d) => d.status === "new-local")) show("new→", d);
      for (const d of diffs.filter((d) => d.status === "new-remote")) show("←new", d);
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
    if (!filePath.endsWith(".md")) {
      // Treat as a slug — look for the file locally
      const slugFile = resolve(`${file}.md`);
      if (existsSync(slugFile)) {
        file = `${file}.md`;
      } else {
        console.error(`File not found: ${filePath}\nDid you mean: sideways diff ${file}.md`);
        process.exit(1);
      }
    } else if (!existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
    const raw = readFileSync(resolve(file), "utf-8");
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

    if (localContent.trim() === remoteContent.trim()) {
      console.log(`${file} ↔ ${space}/${slug}: no changes`);
      return;
    }

    // Use system diff for proper unified diff output
    const { execSync } = await import("node:child_process");
    const { writeFileSync: writeTemp } = await import("node:fs");
    const { join: joinPath } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const remoteTmp = joinPath(tmpdir(), `.sideways-remote-${Date.now()}.md`);
    const localTmp = joinPath(tmpdir(), `.sideways-local-${Date.now()}.md`);
    writeTemp(remoteTmp, remoteContent.trim() + "\n");
    writeTemp(localTmp, localContent.trim() + "\n");

    try {
      execSync(
        `diff -u --label "remote: ${space}/${slug}" --label "local: ${file}" "${remoteTmp}" "${localTmp}"`,
        { stdio: "inherit" },
      );
    } catch {
      // diff exits with 1 when files differ — that's expected
    }

    // Clean up
    const { unlinkSync } = await import("node:fs");
    unlinkSync(remoteTmp);
    unlinkSync(localTmp);
  });

// ── rename ────────────────────────────────────────────────────────────

program
  .command("rename <slug> <new-slug>")
  .description("Rename a document (change its slug)")
  .option("--title <title>", "Also set a new title")
  .option("--space <space>", "Override space from config")
  .action(async (slug: string, newSlug: string, opts: { title?: string; space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = createClient(config.api);

    const patch: Record<string, any> = { slug: newSlug };
    if (opts.title) patch.title = opts.title;

    const doc = await client.patchDocument(space, slug, patch);
    console.log(`Renamed ${space}/${slug} → ${space}/${doc.slug} (${doc.title})`);
  });

// ── move ──────────────────────────────────────────────────────────────

program
  .command("move <slug>")
  .description("Move a document to a different space or section")
  .option("--to-space <space>", "Target space")
  .option("--to-section <section>", "Target section (use 'none' to clear)")
  .option("--space <space>", "Override source space from config")
  .action(async (slug: string, opts: { toSpace?: string; toSection?: string; space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = createClient(config.api);

    const patch: Record<string, any> = {};
    if (opts.toSpace) patch.space = opts.toSpace;
    if (opts.toSection !== undefined) {
      patch.section = opts.toSection === "none" ? null : opts.toSection;
    }

    if (Object.keys(patch).length === 0) {
      console.error("Specify --to-space and/or --to-section");
      process.exit(1);
    }

    const doc = await client.patchDocument(space, slug, patch);
    console.log(`Moved ${slug} → ${doc.spaceId ? "new space" : space}/${doc.slug}`);
  });

// ── duplicate ─────────────────────────────────────────────────────────

program
  .command("duplicate <slug>")
  .description("Duplicate a document")
  .option("--as <slug>", "Slug for the copy")
  .option("--to-space <space>", "Target space (default: same)")
  .option("--space <space>", "Override source space from config")
  .action(async (slug: string, opts: { as?: string; toSpace?: string; space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = createClient(config.api);

    const doc = await client.duplicateDocument(space, slug, {
      targetSpace: opts.toSpace,
      targetSlug: opts.as,
    });
    console.log(`Duplicated → ${doc.slug} (${doc.title})`);
  });

// ── delete ────────────────────────────────────────────────────────────

program
  .command("delete <slug>")
  .description("Delete a document")
  .option("--space <space>", "Override space from config")
  .option("--force", "Skip confirmation")
  .action(async (slug: string, opts: { space?: string; force?: boolean }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = createClient(config.api);

    if (!opts.force) {
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question(`Delete ${space}/${slug}? (y/N) `, resolve);
        rl.close;
      });
      rl.close();
      if (answer.toLowerCase() !== "y") {
        console.log("Cancelled.");
        return;
      }
    }

    await client.deleteDocument(space, slug);
    console.log(`Deleted ${space}/${slug}`);
  });

// ── space-settings ────────────────────────────────────────────────────

program
  .command("space-set <property> <value>")
  .description("Update a space property (name, description, visibility)")
  .option("--space <space>", "Override space from config")
  .action(async (property: string, value: string, opts: { space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = createClient(config.api);

    const valid = ["name", "description", "visibility"];
    if (!valid.includes(property)) {
      console.error(`Invalid property. Use: ${valid.join(", ")}`);
      process.exit(1);
    }
    if (property === "visibility" && !["public", "private"].includes(value)) {
      console.error("Visibility must be 'public' or 'private'.");
      process.exit(1);
    }

    const result = await client.updateSpace(space, { [property]: value });
    console.log(`Updated ${space}: ${property} = ${value}`);
  });

// ── members ───────────────────────────────────────────────────────────

program
  .command("members")
  .description("List space members")
  .option("--space <space>", "Override space from config")
  .action(async (opts: { space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = createClient(config.api);

    const members = await client.getSpaceMembers(space);
    if (members.length === 0) {
      console.log("No members.");
      return;
    }
    for (const m of members) {
      console.log(`  ${m.email}  ${m.name}  (${m.role})`);
    }
  });

program
  .command("member-add <email> [role]")
  .description("Add a member to the space (role: viewer, editor, admin)")
  .option("--space <space>", "Override space from config")
  .action(async (email: string, role: string = "editor", opts: { space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = createClient(config.api);

    const result = await client.addSpaceMember(space, email, role);
    console.log(`Added ${email} as ${role} to ${space}`);
  });

program
  .command("member-remove <email>")
  .description("Remove a member from the space")
  .option("--space <space>", "Override space from config")
  .action(async (email: string, opts: { space?: string }) => {
    const config = requireConfig();
    const space = opts.space ?? config.space;
    const client = createClient(config.api);

    const members = await client.getSpaceMembers(space);
    const member = members.find((m: any) => m.email === email);
    if (!member || !member.memberId) {
      console.error(`Member ${email} not found in ${space}`);
      process.exit(1);
    }

    await client.removeSpaceMember(space, member.memberId);
    console.log(`Removed ${email} from ${space}`);
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
