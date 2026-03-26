#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, resolve, dirname } from "node:path";
import { findConfig, createConfig, requireConfig } from "./config.js";
import { createClient } from "./api.js";
import { login, clearCredentials, getStoredCredentials } from "./auth.js";
import { embedComments, extractComments, type SerializedComment } from "@sideways/markdown";

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

// ── push ──────────────────────────────────────────────────────────────

program
  .command("push <file>")
  .description("Upload a markdown file to the configured space")
  .option("-s, --slug <slug>", "Document slug (defaults to filename)")
  .option("-t, --title <title>", "Document title (defaults to slug)")
  .option("--tags <tags>", "Comma-separated tags")
  .option("--space <space>", "Override space from config")
  .action(
    async (
      file: string,
      opts: {
        slug?: string;
        title?: string;
        tags?: string;
        space?: string;
      },
    ) => {
      const config = requireConfig();
      const space = opts.space ?? config.space;
      const client = createClient(config.api);

      const filePath = resolve(file);
      const raw = readFileSync(filePath, "utf-8");

      // Extract any embedded comments from the markdown
      const { clean, comments: embeddedComments } = extractComments(raw);

      const slug =
        opts.slug ?? basename(file, ".md").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
      const title = opts.title ?? slug;
      const tags = opts.tags?.split(",").map((t) => t.trim()) ?? [];

      const result = await client.putDocument(space, slug, {
        title,
        content: clean,
        tags,
      });

      if (embeddedComments.length > 0) {
        console.log(
          `  ${embeddedComments.length} comment(s) found in file (stored in DB)`,
        );
      }

      console.log(`Pushed ${space}/${slug} (${result.id})`);
    },
  );

// ── pull ──────────────────────────────────────────────────────────────

program
  .command("pull <slug>")
  .description("Download a document as a local markdown file")
  .option("-d, --dir <path>", "Output directory", ".")
  .option("--space <space>", "Override space from config")
  .option("--clean", "Exclude comments from output")
  .option("--include-resolved", "Include resolved comments")
  .action(
    async (
      slug: string,
      opts: {
        dir: string;
        space?: string;
        clean?: boolean;
        includeResolved?: boolean;
      },
    ) => {
      const config = requireConfig();
      const space = opts.space ?? config.space;
      const client = createClient(config.api);

      const doc = await client.getDocument(space, slug);
      let content = doc.content;

      if (!opts.clean) {
        try {
          const rawComments = await client.getComments(
            space,
            slug,
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
                parentId: c.parentId,
                resolved: c.resolved,
              }),
            );
            content = embedComments(content, serialized);
          }
        } catch {
          // Comments not available (no auth, etc.) — pull content only
        }
      }

      const outDir = resolve(opts.dir);
      mkdirSync(outDir, { recursive: true });

      const outPath = resolve(outDir, `${slug}.md`);
      writeFileSync(outPath, content);

      console.log(`Pulled ${space}/${slug} → ${outPath}`);
    },
  );

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
    const config = findConfig() ?? { api: "http://localhost:4100" };
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
  .option(
    "--hydra <url>",
    "Hydra public URL",
    "http://localhost:4444",
  )
  .action(async (opts: { hydra: string }) => {
    const config = findConfig() ?? { api: "http://localhost:4100" };
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
    const config = findConfig() ?? { api: "http://localhost:4100" };
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
