/**
 * Resolve which directories and sections to sync based on config and cwd.
 */

import { resolve, relative } from "node:path";
import type { ProjectConfig, DirMapping } from "./config.js";

export interface SyncTarget {
  localDir: string;
  section: string | null;
}

/**
 * Determine sync targets from config + cwd.
 *
 * - If mappings defined and cwd is inside a mapped dir → just that mapping
 * - If mappings defined and cwd is project root → all mappings
 * - If no mappings → sync project root ↔ space root
 * - If explicit path given → use that path, try to find its mapping
 */
export function resolveSyncTargets(
  config: ProjectConfig,
  explicitPath?: string,
): SyncTarget[] {
  const cwd = process.cwd();

  // Explicit path overrides everything
  if (explicitPath) {
    const absPath = resolve(explicitPath);
    const mapping = findMappingForPath(config, absPath);
    return [{
      localDir: absPath,
      section: mapping?.section ?? null,
    }];
  }

  // No mappings → sync cwd ↔ space root
  if (config.mappings.length === 0) {
    return [{ localDir: cwd, section: null }];
  }

  // Check if cwd is inside a mapped directory
  const rel = relative(config.rootDir, cwd);
  for (const mapping of config.mappings) {
    const mappingPath = mapping.local.replace(/\/$/, "");
    if (rel === mappingPath || rel.startsWith(mappingPath + "/")) {
      return [{
        localDir: resolve(config.rootDir, mappingPath),
        section: mapping.section,
      }];
    }
  }

  // Cwd is project root (or not inside any mapping) → all mappings
  return config.mappings.map((m) => ({
    localDir: resolve(config.rootDir, m.local),
    section: m.section,
  }));
}

function findMappingForPath(
  config: ProjectConfig,
  absPath: string,
): DirMapping | null {
  const rel = relative(config.rootDir, absPath);
  for (const mapping of config.mappings) {
    const mappingPath = mapping.local.replace(/\/$/, "");
    if (rel === mappingPath || rel.startsWith(mappingPath + "/")) {
      return mapping;
    }
  }
  return null;
}
