import { describe, it, expect } from "vitest";
import { docUrl } from "../index.js";

describe("docUrl", () => {
  it("builds a path-style URL with .md stripped", () => {
    expect(docUrl({ spaceSlug: "shikasta", sectionSlug: "docs", path: "architecture/overview.md" }))
      .toBe("/s/shikasta/docs/architecture/overview");
  });

  it("collapses a directory's index.md to the directory URL", () => {
    expect(docUrl({ spaceSlug: "shikasta", sectionSlug: "docs", path: "architecture/index.md" }))
      .toBe("/s/shikasta/docs/architecture");
  });

  it("collapses the section root index.md to the section URL", () => {
    expect(docUrl({ spaceSlug: "shikasta", sectionSlug: "docs", path: "index.md" }))
      .toBe("/s/shikasta/docs");
  });

  it("handles deep paths", () => {
    expect(docUrl({ spaceSlug: "s", sectionSlug: "plans", path: "canvas-foundations-v1/PLAN.md" }))
      .toBe("/s/s/plans/canvas-foundations-v1/PLAN");
  });

  it("URL-encodes segments containing reserved characters", () => {
    expect(docUrl({ spaceSlug: "my space", sectionSlug: "a/b", path: "p&q/x y.md" }))
      .toBe("/s/my%20space/a%2Fb/p%26q/x%20y");
  });

  it("does not strip 'index' when it's part of a longer name", () => {
    expect(docUrl({ spaceSlug: "s", sectionSlug: "docs", path: "indexing.md" }))
      .toBe("/s/s/docs/indexing");
    expect(docUrl({ spaceSlug: "s", sectionSlug: "docs", path: "reindex.md" }))
      .toBe("/s/s/docs/reindex");
  });

  it("does not strip '.md' when it's part of a longer extension", () => {
    expect(docUrl({ spaceSlug: "s", sectionSlug: "docs", path: "notes.mdx" }))
      .toBe("/s/s/docs/notes.mdx");
  });
});
