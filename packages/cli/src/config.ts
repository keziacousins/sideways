import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { parse, stringify } from "yaml";

export interface DirMapping {
  local: string;
  section: string | null;
}

export interface ProjectConfig {
  space: string;
  api: string;
  mappings: DirMapping[];
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
        api: parsed.api ?? DEFAULT_API,
        mappings: (parsed.mappings || []).map((m: any) => ({
          local: m.local,
          section: m.section || null,
        })),
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
): string {
  const configPath = resolve(dir, CONFIG_FILENAME);
  const content = stringify({ space, api });
  writeFileSync(configPath, content);
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
