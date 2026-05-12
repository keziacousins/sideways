import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findConfig, createConfig } from "../config.js";

describe("config", () => {
  const dirs: string[] = [];

  function makeTempDir() {
    const dir = mkdtempSync(join(tmpdir(), "sideways-test-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  describe("findConfig", () => {
    it("finds config in the given directory", () => {
      const dir = makeTempDir();
      writeFileSync(
        join(dir, ".sideways.yml"),
        "space: myproject\napi: http://example.com\n",
      );
      const config = findConfig(dir);
      expect(config?.space).toBe("myproject");
      expect(config?.api).toBe("http://example.com");
      expect(config?.mappings).toEqual([]);
      expect(config?.rootDir).toBe(dir);
    });

    it("walks up to find config in parent directory", () => {
      const parent = makeTempDir();
      const child = join(parent, "sub");
      mkdirSync(child);
      writeFileSync(
        join(parent, ".sideways.yml"),
        "space: parent-space\n",
      );
      const config = findConfig(child);
      expect(config?.space).toBe("parent-space");
    });

    it("returns null when no config found", () => {
      const dir = makeTempDir();
      const config = findConfig(dir);
      expect(config).toBeNull();
    });

    it("uses defaults for missing fields", () => {
      const dir = makeTempDir();
      writeFileSync(join(dir, ".sideways.yml"), "space: minimal\n");
      const config = findConfig(dir);
      expect(config?.space).toBe("minimal");
      expect(config?.api).toBe("http://localhost:4100");
      expect(config?.mappings).toEqual([]);
    });
  });

  describe("createConfig", () => {
    it("creates a .sideways.yml file", () => {
      const dir = makeTempDir();
      const path = createConfig(dir, "test-space");
      expect(path).toContain(".sideways.yml");

      const config = findConfig(dir);
      expect(config?.space).toBe("test-space");
      expect(config?.api).toBe("http://localhost:4100");
    });

    it("creates config with custom API URL", () => {
      const dir = makeTempDir();
      createConfig(dir, "prod", "https://api.example.com");

      const config = findConfig(dir);
      expect(config?.api).toBe("https://api.example.com");
    });
  });
});
