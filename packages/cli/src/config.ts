import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";

export interface ProjectConfig {
  space: string;
  api: string;
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
      const parsed = parse(raw) as Partial<ProjectConfig>;
      return {
        space: parsed.space ?? "default",
        api: parsed.api ?? DEFAULT_API,
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
