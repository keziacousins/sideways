import { describe, it, expect } from "vitest";
import { renderMarkdown, extractDocLinks, type WikiLinkContext } from "../index.js";

/** Documents in space "sp": section "sec" is the one links are written from. */
const DOCS = [
  { sectionSlug: "sec", path: "index.md" },
  { sectionSlug: "sec", path: "guides/index.md" },
  { sectionSlug: "sec", path: "guides/auth.md" },
  { sectionSlug: "sec", path: "guides/intro.md" },
  { sectionSlug: "sec", path: "guides/deep/index.md" },
  { sectionSlug: "other", path: "x.md" },
].map((d) => ({ ...d, title: d.path }));

/** Render `md` as the document at `path` in section "sec". */
function render(
  md: string,
  path = "guides/auth.md",
  extra: Partial<Parameters<typeof renderMarkdown>[1]> = {},
) {
  const wikiLinks: WikiLinkContext = {
    spaceSlug: "sp",
    docs: DOCS,
    sections: [
      { slug: "sec", hasIndex: true },
      { slug: "other", hasIndex: false },
    ],
    from: { sectionSlug: "sec", path },
  };
  return renderMarkdown(md, { target: "web", wikiLinks, ...extra });
}

describe("relative links between documents", () => {
  it("resolves a sibling to its canonical URL", async () => {
    expect(await render("[t](intro.md)")).toContain('<a href="/s/sp/sec/guides/intro">t</a>');
    expect(await render("[t](./intro.md)")).toContain('<a href="/s/sp/sec/guides/intro">t</a>');
  });

  it("keeps the fragment, prefixed to match the target page's heading ids", async () => {
    expect(await render("[t](./intro.md#setup)"))
      .toContain('href="/s/sp/sec/guides/intro#user-content-setup"');
  });

  it("does not prefix a fragment that already carries the prefix", async () => {
    expect(await render("[t](intro.md#user-content-setup)"))
      .toContain('href="/s/sp/sec/guides/intro#user-content-setup"');
  });

  it("collapses a link to index.md onto its directory's URL", async () => {
    expect(await render("[t](../index.md)")).toContain('href="/s/sp/sec"');
    expect(await render("[t](deep/index.md)", "guides/index.md"))
      .toContain('href="/s/sp/sec/guides/deep"');
    expect(await render("[t](guides/index.md)", "index.md")).toContain('href="/s/sp/sec/guides"');
  });

  it("resolves from an index.md page against its own directory", async () => {
    // The case the browser gets wrong: the page is served at `/…/guides`,
    // with no trailing slash, so `auth.md` would land one directory too high.
    expect(await render("[t](auth.md)", "guides/index.md"))
      .toContain('href="/s/sp/sec/guides/auth"');
  });

  it("marks a link to a document that doesn't exist, and gives it no href", async () => {
    const html = await render("[t](missing.md)");
    expect(html).toContain('<span class="doc-link-unresolved">t</span>');
    expect(html).not.toContain("missing.md");
  });

  it("keeps formatting inside an unresolved link", async () => {
    expect(await render("[**bold** text](missing.md)"))
      .toContain('<span class="doc-link-unresolved"><strong>bold</strong> text</span>');
  });

  describe("across sections", () => {
    it("takes the segment one level above the section root as a section slug", async () => {
      expect(await render("[t](../../other/x.md)")).toContain('href="/s/sp/other/x"');
    });

    it("is unresolved when there is no such section", async () => {
      expect(await render("[t](../../nowhere/x.md)")).toContain("doc-link-unresolved");
    });

    it("is unresolved when the section has no such document", async () => {
      expect(await render("[t](../../other/y.md)")).toContain("doc-link-unresolved");
    });

    it("is unresolved when the link climbs above the space", async () => {
      expect(await render("[t](../../../elsewhere/x.md)")).toContain("doc-link-unresolved");
    });

    it("can name the linking document's own section", async () => {
      expect(await render("[t](../../sec/guides/intro.md)"))
        .toContain('href="/s/sp/sec/guides/intro"');
    });
  });

  describe("what it leaves alone", () => {
    it("an external link, even one ending in .md", async () => {
      expect(await render("[t](https://example.com/a.md)"))
        .toContain('<a href="https://example.com/a.md">t</a>');
    });

    it("a root-relative link", async () => {
      expect(await render("[t](/s/sp/sec/guides/intro)"))
        .toContain('<a href="/s/sp/sec/guides/intro">t</a>');
    });

    it("a hosted-file link, which stays an asset link", async () => {
      const html = await render("[t](spec.pdf)");
      expect(html).toContain('href="/a/sp/sec/guides/spec.pdf"');
      expect(html).toContain("asset-link");
    });

    it("a relative link to something that is neither", async () => {
      expect(await render("[t](notes.txt)")).toContain('<a href="notes.txt">t</a>');
    });

    it("link syntax inside a code span or a fence", async () => {
      expect(await render("`[t](intro.md)`")).toContain("<code>[t](intro.md)</code>");
      const fenced = await render("```\n[t](missing.md)\n```");
      expect(fenced).not.toContain("doc-link-unresolved");
      expect(fenced).toContain("[t](missing.md)");
    });

    it("a wikilink, which has its own resolver", async () => {
      const html = await render("[[intro]]");
      expect(html).toContain('href="/s/sp/sec/guides/intro"');
      expect(html).toContain("wiki-link");
    });

    it("everything, when there is no document to resolve against", async () => {
      expect(await renderMarkdown("[t](intro.md)")).toContain('<a href="intro.md">t</a>');
    });
  });

  it("keeps the link's title", async () => {
    expect(await render('[t](intro.md "The intro")'))
      .toContain('<a href="/s/sp/sec/guides/intro" title="The intro">t</a>');
  });

  it("is unresolved for a path that can't be a document's", async () => {
    // Decodes to "My Doc.md"; document paths can't hold a space.
    expect(await render("[t](My%20Doc.md)")).toContain("doc-link-unresolved");
  });

  it("resolves a reference-style link through its definition", async () => {
    expect(await render("See [the intro][i].\n\n[i]: ./intro.md"))
      .toContain('<a href="/s/sp/sec/guides/intro">the intro</a>');
  });

  it("makes the URL absolute on the pdf path", async () => {
    const html = await render("[t](intro.md#setup)", "guides/auth.md", {
      target: "pdf",
      origin: "https://docs.example",
    });
    expect(html).toContain('href="https://docs.example/s/sp/sec/guides/intro#user-content-setup"');
  });
});

describe("extractDocLinks", () => {
  it("lists a document's relative .md links with where each lands", () => {
    const md = "[a](intro.md) [b](../index.md#top) [c](../../other/x.md)";
    expect(extractDocLinks(md, "guides/auth.md")).toEqual([
      { href: "intro.md", ref: { sectionSlug: null, path: "guides/intro.md" } },
      { href: "../index.md", ref: { sectionSlug: null, path: "index.md" } },
      { href: "../../other/x.md", ref: { sectionSlug: "other", path: "x.md" } },
    ]);
  });

  it("gives a null ref for a link that climbs above the space", () => {
    expect(extractDocLinks("[t](../../../elsewhere/x.md)", "guides/auth.md"))
      .toEqual([{ href: "../../../elsewhere/x.md", ref: null }]);
  });

  it("lists each link once, and follows reference definitions", () => {
    const md = "[a](intro.md) [b](intro.md#x) [c][i]\n\n[i]: intro.md";
    expect(extractDocLinks(md, "guides/auth.md").map((l) => l.href)).toEqual(["intro.md"]);
  });

  it("skips code, external links, assets and images", () => {
    const md = [
      "```",
      "[fenced](fenced.md)",
      "```",
      "`[inline](inline.md)`",
      "[ext](https://example.com/a.md) [pdf](spec.pdf) ![img](pic.md)",
    ].join("\n");
    expect(extractDocLinks(md, "auth.md")).toEqual([]);
  });

  it("agrees with the renderer about which links resolve", async () => {
    const md = "[a](intro.md) [b](missing.md) [c](../../other/x.md)";
    const html = await render(md);
    const [a, b, c] = extractDocLinks(md, "guides/auth.md");
    expect(a.ref).toEqual({ sectionSlug: null, path: "guides/intro.md" });
    expect(html).toContain("/s/sp/sec/guides/intro");
    expect(b.ref).toEqual({ sectionSlug: null, path: "guides/missing.md" });
    expect(html).toContain('<span class="doc-link-unresolved">b</span>');
    expect(c.ref).toEqual({ sectionSlug: "other", path: "x.md" });
    expect(html).toContain("/s/sp/other/x");
  });
});
