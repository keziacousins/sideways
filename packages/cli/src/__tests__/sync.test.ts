import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverFiles, matchAddArg } from "../sync.js";

describe("matchAddArg", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A tree where README.md and PROFILE.md each appear more than once, with
   *  the shallower copy discovered first. */
  function makeTree() {
    const root = mkdtempSync(join(tmpdir(), "sideways-test-"));
    dirs.push(root);
    for (const rel of [
      "README.md",
      "capital-banking/PROFILE.md",
      "vendors/idee/README.md",
      "vendors/idee/PROFILE.md",
      "vendors/idee/notes.md",
    ]) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), "# x\n");
    }
    return discoverFiles(root, [{ sectionSlug: "docs", dir: root, relDir: "" }]);
  }

  const paths = (files: { relPath: string }[]) => files.map(f => f.relPath);

  it("prefers the exact path over an earlier file with the same name", () => {
    const files = makeTree();
    expect(paths(matchAddArg(files, "vendors/idee/README.md", "vendors/idee/README.md")))
      .toEqual(["vendors/idee/README.md"]);
    expect(paths(matchAddArg(files, "vendors/idee/PROFILE.md", "vendors/idee/PROFILE.md")))
      .toEqual(["vendors/idee/PROFILE.md"]);
  });

  it("does not fall back to a filename match when the argument has a directory", () => {
    const files = makeTree();
    expect(matchAddArg(files, "other/README.md", "other/README.md")).toEqual([]);
  });

  it("resolves a bare name that is unique", () => {
    const files = makeTree();
    expect(paths(matchAddArg(files, "elsewhere/notes", "notes"))).toEqual(["vendors/idee/notes.md"]);
  });

  it("returns every candidate for a bare name that is ambiguous", () => {
    const files = makeTree();
    expect(paths(matchAddArg(files, "elsewhere/PROFILE.md", "PROFILE.md")).sort())
      .toEqual(["capital-banking/PROFILE.md", "vendors/idee/PROFILE.md"]);
  });
});
