import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { parse, stringify } from "yaml";

export interface DirMapping {
  local: string;
  section: string | null;
}

export interface SectionMapping {
  /** Relative path from root to the directory */
  path: string;
  /** Section name (display). Slug derived from this if slug not set. */
  name?: string;
  /** Section slug (URL-friendly). Auto-derived from name or path if omitted. */
  slug?: string;
}

export interface ProjectConfig {
  space: string;
  spaceName: string | null;
  api: string;
  mappings: DirMapping[];
  /** If set, recursive sync from this directory. First-level dirs = sections, deeper = doc nesting. */
  root: string | null;
  /** Explicit path-to-section mappings. When set, only these directories are synced. */
  sections: SectionMapping[];
  /** Additional directory names to ignore during discovery */
  ignore: string[];
  /** Absolute path to the directory containing .sideways.yml */
  rootDir: string;
}

const CONFIG_FILENAME = ".sideways.yml";
const DEFAULT_API = "http://localhost:4100";

/**
 * Walk up from cwd to find .sideways.yml
 */
export function findConfig(from: string = process.cwd()): ProjectConfig | null {
  let dir = resolve(from);
  while (true) {
    const configPath = resolve(dir, CONFIG_FILENAME);
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = parse(raw) as any;
      return {
        space: parsed.space ?? "default",
        spaceName: parsed.name ?? null,
        api: parsed.api ?? DEFAULT_API,
        mappings: (parsed.mappings || []).map((m: any) => ({
          local: m.local,
          section: m.section || null,
        })),
        root: parsed.root ?? null,
        sections: (parsed.sections || []).map((s: any) => ({
          path: s.path,
          name: s.name,
          slug: s.slug,
        })),
        ignore: parsed.ignore ?? [],
        rootDir: dir,
      };
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Create a .sideways.yml in the given directory
 */
export function createConfig(
  dir: string,
  space: string,
  api: string = DEFAULT_API,
  name?: string,
): string {
  const configPath = resolve(dir, CONFIG_FILENAME);
  const data: Record<string, any> = { space, api, root: "." };
  if (name && name !== space) data.name = name;
  const content = stringify(data);
  writeFileSync(configPath, content);

  // Clear stale sync state from a previous config
  const syncDir = resolve(dir, ".sideways");
  const syncFile = resolve(syncDir, "sync.json");
  if (existsSync(syncFile)) {
    try {
      const old = JSON.parse(readFileSync(syncFile, "utf-8"));
      if (old.space !== space) {
        writeFileSync(syncFile, "{}");
      }
    } catch {}
  }

  return configPath;
}

/**
 * Get config or exit with error
 */
export function requireConfig(): ProjectConfig {
  const config = findConfig();
  if (!config) {
    console.error(
      "No .sideways.yml found. Run `sideways init <space>` first.",
    );
    process.exit(1);
  }
  return config;
}

/**
 * Find the mapping that contains the current working directory.
 * Returns null if cwd is the project root (no specific mapping).
 */
export function findMappingForCwd(config: ProjectConfig): DirMapping | null {
  const cwd = process.cwd();
  const rel = relative(config.rootDir, cwd);

  for (const mapping of config.mappings) {
    const mappingPath = mapping.local.replace(/\/$/, "");
    if (rel === mappingPath || rel.startsWith(mappingPath + "/")) {
      return mapping;
    }
  }

  return null;
}
