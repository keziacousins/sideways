import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { parse, stringify } from "yaml";

/**
 * .sideways.yml — per-repo config under the path-and-sections model.
 *
 *   space: my-docs                # required
 *   api: https://sideways.example # required
 *   name: My Docs                 # optional display name
 *   sections:                     # required, at least one entry
 *     default: .                  # section slug → local mount directory
 *     frontend: ./docs/frontend
 *   ignore:                       # optional ignore patterns (relative)
 *     - references
 *
 * A `sections:` entry declares "this repo owns this section, and its docs
 * live at this local path". Sections absent from the map are out of scope
 * for this repo — sync operations skip them entirely.
 */
export interface ProjectConfig {
  /** Space slug on the server. */
  space: string;
  /** Optional display name. */
  spaceName: string | null;
  /** API base URL. */
  api: string;
  /** Map of section slug → local directory (relative to rootDir or absolute). */
  sections: Record<string, string>;
  /** Extra ignore patterns for filesystem walks. */
  ignore: string[];
  /** Absolute path to the directory containing .sideways.yml. */
  rootDir: string;
}

const CONFIG_FILENAME = ".sideways.yml";

/** Walk up from cwd to find .sideways.yml. Returns null if none found. */
export function findConfig(from: string = process.cwd()): ProjectConfig | null {
  let dir = resolve(from);
  while (true) {
    const configPath = resolve(dir, CONFIG_FILENAME);
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8");
      return validateConfig(parse(raw), dir, configPath);
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Get config or exit with error. */
export function requireConfig(): ProjectConfig {
  const config = findConfig();
  if (!config) {
    console.error("No .sideways.yml found. Run `sideways init <space>` first.");
    process.exit(1);
  }
  return config;
}

/**
 * Validate a parsed YAML object against the path-and-sections schema.
 * Exits with a clear, actionable message on failure.
 *
 * Legacy configs (with `mappings:`, `root:`, or no `sections:` at all) are
 * rejected by this validator — there's a one-shot migration helper:
 * `sideways migrate-config`.
 */
function validateConfig(parsed: any, dir: string, configPath: string): ProjectConfig {
  if (!parsed || typeof parsed !== "object") {
    fail("Config is empty or not a YAML object.", configPath);
  }

  if (typeof parsed.space !== "string" || !parsed.space) {
    fail("Missing required `space:` (the space slug).", configPath);
  }

  if (typeof parsed.api !== "string" || !parsed.api) {
    fail("Missing required `api:` (the API base URL).", configPath);
  }

  // Detect legacy shape so we can point users at the migration helper.
  if ("mappings" in parsed || "root" in parsed) {
    fail(
      "Legacy config detected (`mappings:` or `root:` keys).\n" +
      "  This CLI requires the path-and-sections schema. Run:\n" +
      "    sideways migrate-config\n" +
      "  to rewrite .sideways.yml automatically.",
      configPath,
    );
  }

  if (!parsed.sections || typeof parsed.sections !== "object" || Array.isArray(parsed.sections)) {
    fail(
      "Missing required `sections:` block (map of section slug → local path).\n" +
      "  For a flat layout, add:\n" +
      "    sections:\n" +
      "      default: .\n" +
      "  Or run `sideways migrate-config` to derive a starter block.",
      configPath,
    );
  }

  const sections: Record<string, string> = {};
  for (const [slug, value] of Object.entries(parsed.sections)) {
    if (typeof slug !== "string" || !/^[a-z0-9-]+$/.test(slug)) {
      fail(`Invalid section slug \`${slug}\` — slugs must be lowercase alphanumeric + hyphens.`, configPath);
    }
    if (typeof value !== "string" || !value) {
      fail(`Section \`${slug}\` must map to a non-empty local path string.`, configPath);
    }
    if (isAbsolute(value)) {
      fail(`Section \`${slug}\` path must be relative to ${dir}, not absolute.`, configPath);
    }
    sections[slug] = value;
  }

  if (Object.keys(sections).length === 0) {
    fail("`sections:` block is empty — declare at least one section to sync.", configPath);
  }

  const ignore = Array.isArray(parsed.ignore)
    ? parsed.ignore.filter((p: unknown): p is string => typeof p === "string")
    : [];

  return {
    space: parsed.space,
    spaceName: typeof parsed.name === "string" ? parsed.name : null,
    api: parsed.api,
    sections,
    ignore,
    rootDir: dir,
  };
}

function fail(message: string, configPath: string): never {
  console.error(`Error in ${configPath}:`);
  console.error(`  ${message.split("\n").join("\n  ")}`);
  process.exit(1);
}

/** Create a starter .sideways.yml in the given directory. */
export function createConfig(
  dir: string,
  space: string,
  api: string,
  name?: string,
): string {
  const configPath = resolve(dir, CONFIG_FILENAME);
  const data: Record<string, any> = {
    space,
    api,
    sections: { default: "." },
  };
  if (name && name !== space) data.name = name;
  writeFileSync(configPath, stringify(data));

  // Clear stale sync state from a previous config in this directory.
  const syncFile = resolve(dir, ".sideways", "sync.json");
  if (existsSync(syncFile)) {
    try {
      const old = JSON.parse(readFileSync(syncFile, "utf-8"));
      if (old.space !== space) writeFileSync(syncFile, "{}");
    } catch {}
  }

  return configPath;
}
