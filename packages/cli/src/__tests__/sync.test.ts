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
    const parsed = parseFrontmatter('---\ntitle: "Data Cards: card collections"\n---\nbody\n');
    expect(parsed.title).toBe("Data Cards: card collections");
    expect(parsed.content).toBe("body\n");
  });

  it("undoes the escapes of each quote style", () => {
    expect(parseFrontmatter("---\ntitle: 'Kezia''s notes'\n---\n").title).toBe("Kezia's notes");
    expect(parseFrontmatter('---\ntitle: "The \\"best\\" plan"\n---\n').title).toBe('The "best" plan');
  });

  it("splits title and tags from the rest, block lists and all", () => {
    const parsed = parseFrontmatter(
      [
        "---",
        "title: Plan",
        "type: critique # inline comment",
        "repos:",
        "  - sideways",
        "  - cli",
        "created: 2026-10-01",
        "tags:",
        "  - a",
        "  - b",
        "review: { by: kezia, done: false }",
        "---",
        "body",
      ].join("\n"),
    );
    expect(parsed.title).toBe("Plan");
    expect(parsed.tags).toEqual(["a", "b"]);
    expect(parsed.frontmatter).toEqual({
      type: "critique",
      repos: ["sideways", "cli"],
      created: "2026-10-01",
      review: { by: "kezia", done: false },
    });
  });

  it("reads a single tag and a numeric title as strings", () => {
    const parsed = parseFrontmatter("---\ntitle: 2026\ntags: api\n---\n");
    expect(parsed.title).toBe("2026");
    expect(parsed.tags).toEqual(["api"]);
  });

  it("reports frontmatter that isn't valid YAML, and still finds the content", () => {
    const parsed = parseFrontmatter("---\ntitle: Data Cards: card collections\n---\nbody\n");
    expect(parsed.error).toBeTruthy();
    expect(parsed.content).toBe("body\n");
  });

  it("returns a file without frontmatter as it is", () => {
    expect(parseFrontmatter("# Plan\n")).toEqual({ tags: [], frontmatter: {}, content: "# Plan\n" });
  });
});

describe("fileForDisk", () => {
  const text = (...args: Parameters<typeof fileForDisk>) => fileForDisk(...args).text;

  it("quotes a title that wouldn't be a valid plain YAML scalar", () => {
    expect(text({ title: "Data Cards: card collections" }, "body\n")).toBe(
      '---\ntitle: "Data Cards: card collections"\n---\nbody\n',
    );
  });

  it("omits a title that matches the H1, and frontmatter with nothing in it", () => {
    expect(text({ title: "Plan", tags: [], frontmatter: {} }, "# Plan\n")).toBe("# Plan\n");
  });

  it("writes the server's frontmatter into a new file, title first", () => {
    const out = text(
      { title: "Plan B", tags: ["x"], frontmatter: { status: "draft", repos: ["a", "b"] } },
      "# Plan\n",
    );
    expect(out).toBe(
      "---\ntitle: Plan B\nstatus: draft\nrepos:\n  - a\n  - b\ntags:\n  - x\n---\n# Plan\n",
    );
  });

  it("round-trips through parseFrontmatter", () => {
    const doc = {
      title: '"Quoted": a "title" #1',
      tags: ["x", "y: z"],
      frontmatter: { status: "draft", nested: { list: [1, "two"] } },
    };
    const parsed = parseFrontmatter(text(doc, "body\n"));
    expect(parsed).toEqual({ ...doc, content: "body\n" });
  });

  it("applies the server's values to the local file, keeping its layout", () => {
    const local = [
      "---",
      'title: "Old title"',
      "type: critique",
      "# reviewed weekly",
      "repos: [sideways, cli]",
      "created: 2026-10-01",
      "stale: gone",
      "tags: [old]",
      "---",
      "# Old title",
      "",
    ].join("\n");
    const out = text(
      {
        title: "New: title",
        tags: ["a", "b"],
        frontmatter: { type: "critique", repos: ["sideways", "cli"], created: "2026-10-02" },
      },
      "# New\n",
      local,
    );
    expect(out).toBe(
      [
        "---",
        'title: "New: title"',
        "type: critique",
        "# reviewed weekly",
        "repos: [sideways, cli]",
        "created: 2026-10-02",
        "tags: [a, b]",
        "---",
        "# New",
        "",
      ].join("\n"),
    );
  });

  it("leaves local keys alone when the server has never been sent frontmatter", () => {
    const local = "---\nstatus: draft\nrepos:\n  - a\n---\nbody\n";
    expect(text({ frontmatter: null }, "body\n", local)).toBe(local);
    expect(text({}, "body\n", local)).toBe(local);
  });

  it("removes local keys the server's frontmatter doesn't have", () => {
    const local = "---\nstatus: draft\n---\nbody\n";
    expect(text({ frontmatter: {} }, "body\n", local)).toBe("body\n");
  });

  it("keeps a local title line even when it matches the H1", () => {
    const local = "---\ntitle: Plan\nstatus: draft\n---\n# Plan\n";
    expect(text({ title: "Plan", frontmatter: { status: "draft" } }, "# Plan\n", local)).toBe(local);
  });

  it("keeps a local block that isn't valid YAML, with a warning", () => {
    const local = "---\ntitle: Data Cards: card collections\nstatus: draft\n---\nold\n";
    const out = fileForDisk({ title: "Data Cards", frontmatter: {} }, "new\n", local);
    expect(out.text).toBe("---\ntitle: Data Cards: card collections\nstatus: draft\n---\nnew\n");
    expect(out.warning).toBeTruthy();
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
