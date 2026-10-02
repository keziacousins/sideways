import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { findDocLinkGaps } from "../doclinks.js";
import { syncKey } from "../sync.js";

describe("findDocLinkGaps", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /**
   * A repo with two sections mounted from sibling directories, `docs/` and
   * `platform/`, holding the given files.
   */
  function makeRepo(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "sideways-doclinks-"));
    dirs.push(root);
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    const mounts = ["docs", "platform"].map((slug) => ({
      sectionSlug: slug,
      dir: join(root, slug),
      relDir: slug,
    }));
    /** A document in section `docs`, as discovery would describe it. */
    const doc = (path: string) => ({
      sectionSlug: "docs",
      path,
      absPath: join(root, "docs", path),
      relPath: `docs/${path}`,
    });
    return { mounts, doc };
  }

  const known = (...keys: Array<[string, string]>) =>
    new Set(keys.map(([section, path]) => syncKey(section, path)));

  it("finds nothing wrong with links to documents that are synced", () => {
    const { mounts, doc } = makeRepo({
      "docs/guides/auth.md": "[a](intro.md) [b](../index.md) [c](../../platform/api.md)",
    });
    const gaps = findDocLinkGaps({
      files: [doc("guides/auth.md")],
      known: known(["docs", "guides/intro.md"], ["docs", "index.md"], ["platform", "api.md"]),
      mounts,
    });
    expect(gaps).toEqual([]);
  });

  it("reports a link to a file that doesn't exist", () => {
    const { mounts, doc } = makeRepo({ "docs/guides/auth.md": "[a](gone.md)" });
    expect(findDocLinkGaps({ files: [doc("guides/auth.md")], known: known(), mounts })).toEqual([
      { docRelPath: "docs/guides/auth.md", href: "gone.md", reason: "missing" },
    ]);
  });

  it("tells a file that exists but isn't synced from one that is missing", () => {
    // On disk, so the link works locally — but untracked or ignored, so the
    // server will never have it.
    const { mounts, doc } = makeRepo({
      "docs/guides/auth.md": "[a](draft.md) [b](../../platform/internal.md)",
      "docs/guides/draft.md": "# draft",
      "platform/internal.md": "# internal",
    });
    expect(findDocLinkGaps({ files: [doc("guides/auth.md")], known: known(), mounts })).toEqual([
      { docRelPath: "docs/guides/auth.md", href: "draft.md", reason: "unsynced" },
      { docRelPath: "docs/guides/auth.md", href: "../../platform/internal.md", reason: "unsynced" },
    ]);
  });

  it("accepts a target the server has even when this repo doesn't mount its section", () => {
    const { mounts, doc } = makeRepo({ "docs/auth.md": "[a](../elsewhere/x.md)" });
    expect(
      findDocLinkGaps({ files: [doc("auth.md")], known: known(["elsewhere", "x.md"]), mounts }),
    ).toEqual([]);
  });

  it("reports a link into a section nobody has", () => {
    const { mounts, doc } = makeRepo({ "docs/auth.md": "[a](../elsewhere/x.md)" });
    expect(findDocLinkGaps({ files: [doc("auth.md")], known: known(), mounts })).toEqual([
      { docRelPath: "docs/auth.md", href: "../elsewhere/x.md", reason: "missing" },
    ]);
  });

  it("reports a link that climbs above every section", () => {
    const { mounts, doc } = makeRepo({ "docs/auth.md": "[a](../../other-repo/x.md)" });
    expect(findDocLinkGaps({ files: [doc("auth.md")], known: known(), mounts })).toEqual([
      { docRelPath: "docs/auth.md", href: "../../other-repo/x.md", reason: "outside" },
    ]);
  });

  it("looks past frontmatter, and ignores links in code and to the web", () => {
    const { mounts, doc } = makeRepo({
      "docs/auth.md": [
        "---",
        "title: Auth",
        "---",
        "```",
        "[fenced](fenced.md)",
        "```",
        "[web](https://example.com/a.md) [real](gone.md)",
      ].join("\n"),
    });
    expect(findDocLinkGaps({ files: [doc("auth.md")], known: known(), mounts })).toEqual([
      { docRelPath: "docs/auth.md", href: "gone.md", reason: "missing" },
    ]);
  });
});
