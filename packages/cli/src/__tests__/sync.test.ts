import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverFiles,
  matchAddArg,
  parseFrontmatter,
  pushAction,
  fileForDisk,
} from "../sync.js";

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

describe("parseFrontmatter", () => {
  it("strips the quotes from a quoted title", () => {
    const { frontmatter } = parseFrontmatter(
      '---\ntitle: "Data Cards: card collections"\n---\nbody\n',
    );
    expect(frontmatter.title).toBe("Data Cards: card collections");
  });

  it("strips single quotes and undoes their escaping", () => {
    const { frontmatter } = parseFrontmatter("---\ntitle: 'Kezia''s notes'\n---\n");
    expect(frontmatter.title).toBe("Kezia's notes");
  });

  it("undoes escaped quotes inside double quotes", () => {
    const { frontmatter } = parseFrontmatter('---\ntitle: "The \\"best\\" plan"\n---\n');
    expect(frontmatter.title).toBe('The "best" plan');
  });

  it("leaves unquoted and unbalanced values alone", () => {
    const { frontmatter } = parseFrontmatter(
      '---\ntitle: Plain title\nsubtitle: "half\n---\n',
    );
    expect(frontmatter.title).toBe("Plain title");
    expect(frontmatter.subtitle).toBe('"half');
  });

  it("strips quotes from tag items", () => {
    const { frontmatter } = parseFrontmatter("---\ntags: [\"a\", 'b', c]\n---\n");
    expect(frontmatter.tags).toEqual(["a", "b", "c"]);
  });
});

describe("fileForDisk", () => {
  it("quotes a title that wouldn't be a valid plain YAML scalar", () => {
    const out = fileForDisk({ title: "Data Cards: card collections" }, "body\n");
    expect(out).toBe('---\ntitle: "Data Cards: card collections"\n---\nbody\n');
  });

  it("leaves an ordinary title unquoted", () => {
    const out = fileForDisk({ title: "Data Cards prototype — critique" }, "");
    expect(out).toBe("---\ntitle: Data Cards prototype — critique\n---\n");
  });

  it("omits a title that matches the H1, and frontmatter with nothing in it", () => {
    expect(fileForDisk({ title: "Plan", tags: [] }, "# Plan\n")).toBe("# Plan\n");
  });

  it("round-trips through parseFrontmatter", () => {
    const doc = { title: '"Quoted": a "title" #1', tags: ["x", "y: z"] };
    const { frontmatter, content } = parseFrontmatter(fileForDisk(doc, "body\n"));
    expect(frontmatter).toEqual(doc);
    expect(content).toBe("body\n");
  });

  it("keeps local frontmatter the server doesn't hold, as written", () => {
    const local = [
      "---",
      'title: "Old title"',
      "type: critique",
      "# reviewed weekly",
      "repos:",
      "  - sideways",
      "  - cli",
      "created: 2026-10-01",
      "tags: [old]",
      "summary: >",
      "  Folded",
      "  text",
      "---",
      "# Old title",
      "",
    ].join("\n");
    const out = fileForDisk({ title: "New: title", tags: ["a", "b"] }, "# New\n", local);
    expect(out).toBe(
      [
        "---",
        'title: "New: title"',
        "type: critique",
        "# reviewed weekly",
        "repos:",
        "  - sideways",
        "  - cli",
        "created: 2026-10-01",
        "tags: [a, b]",
        "summary: >",
        "  Folded",
        "  text",
        "---",
        "# New",
        "",
      ].join("\n"),
    );
  });

  it("keeps a local title line even when it matches the H1", () => {
    const local = "---\ntitle: Plan\nstatus: draft\n---\n# Plan\n";
    expect(fileForDisk({ title: "Plan" }, "# Plan\n", local)).toBe(local);
  });

  it("drops server-owned keys the server no longer has, including block lists", () => {
    const local = "---\nstatus: draft\ntags:\n  - stale\n  - gone\n---\nbody\n";
    expect(fileForDisk({ tags: [] }, "body\n", local)).toBe("---\nstatus: draft\n---\nbody\n");
  });
});

describe("pushAction", () => {
  it("pushes only local changes without --force", () => {
    expect(pushAction("local-modified", false)).toBe("push");
    expect(pushAction("new-local", false)).toBe("push");
    expect(pushAction("unchanged", false)).toBe("skip");
    expect(pushAction("remote-modified", false)).toBe("skip");
    expect(pushAction("conflict", false)).toBe("conflict");
  });

  it("pushes every file with --force, unchanged ones included", () => {
    for (const status of ["unchanged", "remote-modified", "conflict", "local-modified"] as const) {
      expect(pushAction(status, true)).toBe("push");
    }
  });
});
