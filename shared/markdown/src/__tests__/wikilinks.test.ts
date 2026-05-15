import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../index.js";
import type { WikiLinkContext } from "../wikilinks.js";

const ctx: WikiLinkContext = {
  spaceSlug: "shikasta",
  docs: [
    { sectionSlug: "docs", path: "architecture/overview.md", title: "Overview" },
    { sectionSlug: "docs", path: "architecture/auth.md", title: "Auth" },
    { sectionSlug: "docs", path: "guides/intro.md", title: "Intro" },
    { sectionSlug: "docs", path: "index.md", title: "Docs Home" },
    { sectionSlug: "plans", path: "v1/PLAN.md", title: "Plan v1" },
    { sectionSlug: "plans", path: "v2/PLAN.md", title: "Plan v2" },
    { sectionSlug: "plans", path: "index.md", title: "Plans Home" },
    { sectionSlug: "notes", path: "ideas.md", title: "Ideas" },
  ],
  sections: [
    { slug: "docs", hasIndex: true },
    { slug: "plans", hasIndex: true },
    { slug: "notes", hasIndex: false },
  ],
  from: { sectionSlug: "docs", path: "architecture/overview.md" },
};

describe("wikilinks", () => {
  it("resolves a path-qualified link within the same section", async () => {
    const html = await renderMarkdown("See [[architecture/auth]].", { target: "web", wikiLinks: ctx });
    expect(html).toContain('href="/s/shikasta/docs/architecture/auth"');
    expect(html).toContain('class="wiki-link"');
  });

  it("resolves a relative ./sibling link", async () => {
    const html = await renderMarkdown("See [[./auth]].", { target: "web", wikiLinks: ctx });
    expect(html).toContain('href="/s/shikasta/docs/architecture/auth"');
  });

  it("resolves a relative ../up link", async () => {
    const html = await renderMarkdown("See [[../guides/intro]].", { target: "web", wikiLinks: ctx });
    expect(html).toContain('href="/s/shikasta/docs/guides/intro"');
  });

  it("resolves a bare basename via same-section unique match", async () => {
    const html = await renderMarkdown("See [[auth]].", { target: "web", wikiLinks: ctx });
    expect(html).toContain('href="/s/shikasta/docs/architecture/auth"');
  });

  it("resolves a bare basename via space-wide unique match", async () => {
    const html = await renderMarkdown("See [[ideas]].", { target: "web", wikiLinks: ctx });
    expect(html).toContain('href="/s/shikasta/notes/ideas"');
  });

  it("resolves [[section]] to the section root when an index exists", async () => {
    const html = await renderMarkdown("See [[plans]].", { target: "web", wikiLinks: ctx });
    expect(html).toContain('href="/s/shikasta/plans"');
  });

  it("does not resolve [[section]] when the section has no index doc", async () => {
    // "notes" has hasIndex: false; "notes" is also not a unique basename match
    const html = await renderMarkdown("See [[notes]].", { target: "web", wikiLinks: ctx });
    expect(html).toContain("wiki-link-unresolved");
    expect(html).not.toContain('href="/s/shikasta/notes"');
  });

  it("marks ambiguous bare-basename matches as ambiguous", async () => {
    // Two PLAN.md docs across plans/v1 and plans/v2 — bare [[PLAN]] is ambiguous
    const ambigCtx: WikiLinkContext = { ...ctx, from: undefined };
    const html = await renderMarkdown("See [[PLAN]].", { target: "web", wikiLinks: ambigCtx });
    expect(html).toContain("wiki-link-ambiguous");
  });

  it("marks unknown targets as unresolved", async () => {
    const html = await renderMarkdown("See [[does-not-exist]].", { target: "web", wikiLinks: ctx });
    expect(html).toContain("wiki-link-unresolved");
    expect(html).not.toContain("href=");
  });

  it("uses display text when provided", async () => {
    const html = await renderMarkdown("See [[architecture/auth|the auth doc]].", { target: "web", wikiLinks: ctx });
    expect(html).toContain("the auth doc");
  });

  it("renders all wikilinks unresolved when no context is supplied", async () => {
    const html = await renderMarkdown("See [[anything]].", { target: "web" });
    expect(html).toContain("wiki-link-unresolved");
  });

  it("renders an unresolved relative link when from is missing", async () => {
    const noFrom: WikiLinkContext = { ...ctx, from: undefined };
    const html = await renderMarkdown("See [[./auth]].", { target: "web", wikiLinks: noFrom });
    expect(html).toContain("wiki-link-unresolved");
  });

  it("does not resolve a relative link that escapes the section root", async () => {
    const html = await renderMarkdown("See [[../../escape]].", { target: "web", wikiLinks: ctx });
    expect(html).toContain("wiki-link-unresolved");
  });
});
