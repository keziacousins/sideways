import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findConfig, createConfig } from "../config.js";

describe("config", () => {
  const dirs: string[] = [];
  const exits: Array<() => void> = [];

  function makeTempDir() {
    const dir = mkdtempSync(join(tmpdir(), "sideways-test-"));
    dirs.push(dir);
    return dir;
  }

  /** Capture process.exit + stderr so we can assert on validation failures. */
  function expectFail(fn: () => void) {
    const origExit = process.exit;
    const origError = console.error;
    const captured: string[] = [];
    let exitCode: number | undefined;
    (process as any).exit = (code: number) => {
      exitCode = code;
      throw new Error("__exit__");
    };
    console.error = (...args: any[]) => { captured.push(args.join(" ")); };
    exits.push(() => { process.exit = origExit; console.error = origError; });
    try {
      fn();
    } catch (e: any) {
      if (e.message !== "__exit__") throw e;
    }
    return { exitCode, stderr: captured.join("\n") };
  }

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    for (const r of exits) r();
    dirs.length = 0;
    exits.length = 0;
  });

  describe("findConfig", () => {
    it("parses a valid path-and-sections config", () => {
      const dir = makeTempDir();
      writeFileSync(
        join(dir, ".sideways.yml"),
        "space: myproject\napi: http://example.com\nsections:\n  default: .\n",
      );
      const config = findConfig(dir);
      expect(config?.space).toBe("myproject");
      expect(config?.api).toBe("http://example.com");
      expect(config?.sections).toEqual({ default: "." });
      expect(config?.rootDir).toBe(dir);
    });

    it("walks up to find config in parent directory", () => {
      const parent = makeTempDir();
      const child = join(parent, "sub");
      mkdirSync(child);
      writeFileSync(
        join(parent, ".sideways.yml"),
        "space: parent\napi: http://x\nsections:\n  default: .\n",
      );
      const config = findConfig(child);
      expect(config?.space).toBe("parent");
    });

    it("returns null when no config found", () => {
      const dir = makeTempDir();
      expect(findConfig(dir)).toBeNull();
    });

    it("rejects legacy `mappings:` config", () => {
      const dir = makeTempDir();
      writeFileSync(
        join(dir, ".sideways.yml"),
        "space: old\napi: http://x\nmappings:\n  - {local: docs, section: docs}\n",
      );
      const { stderr } = expectFail(() => findConfig(dir));
      expect(stderr).toMatch(/Legacy config/);
      expect(stderr).toMatch(/migrate-config/);
    });

    it("rejects config without sections block", () => {
      const dir = makeTempDir();
      writeFileSync(join(dir, ".sideways.yml"), "space: x\napi: http://x\n");
      const { stderr } = expectFail(() => findConfig(dir));
      expect(stderr).toMatch(/Missing required `sections:` block/);
    });

    it("rejects absolute mount paths", () => {
      const dir = makeTempDir();
      writeFileSync(
        join(dir, ".sideways.yml"),
        "space: x\napi: http://x\nsections:\n  default: /etc/passwd\n",
      );
      const { stderr } = expectFail(() => findConfig(dir));
      expect(stderr).toMatch(/must be relative/);
    });
  });

  describe("createConfig", () => {
    it("creates a starter config with default section mapped to root", () => {
      const dir = makeTempDir();
      const path = createConfig(dir, "test-space", "http://x");
      expect(path).toContain(".sideways.yml");
      const config = findConfig(dir);
      expect(config?.space).toBe("test-space");
      expect(config?.sections).toEqual({ default: "." });
    });

    it("preserves a custom API URL", () => {
      const dir = makeTempDir();
      createConfig(dir, "prod", "https://api.example.com");
      const config = findConfig(dir);
      expect(config?.api).toBe("https://api.example.com");
    });
  });
});
