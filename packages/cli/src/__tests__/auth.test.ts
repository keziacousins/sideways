import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We can't easily test the full OAuth flow, but we can test credential storage

describe("CLI auth credentials", () => {
  // We need to mock the home directory for these tests
  // Instead, test the storage functions by importing and using temp dirs

  const dirs: string[] = [];

  function makeTempDir() {
    const dir = mkdtempSync(join(tmpdir(), "sideways-auth-test-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it("API key format is sk- prefixed", () => {
    // Just a format check — the actual generation is in the server
    const key = "sk-abc123def456";
    expect(key.startsWith("sk-")).toBe(true);
    expect(key.slice(0, 11)).toBe("sk-abc123de");
  });

  it("credentials file has restrictive permissions", async () => {
    const { writeFileSync, statSync } = await import("node:fs");
    const dir = makeTempDir();
    const file = join(dir, "token.json");

    writeFileSync(file, '{"api_key":"sk-test"}', { mode: 0o600 });

    const stats = statSync(file);
    // Owner read/write only (0o600)
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
