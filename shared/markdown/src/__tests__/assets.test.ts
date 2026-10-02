import { describe, it, expect } from "vitest";
import { renderMarkdown, type WikiLinkContext } from "../index.js";

/** Render `md` as the document at `path` in space "sp", section "docs". */
function render(
  md: string,
  path = "guides/auth.md",
  extra: Partial<Parameters<typeof renderMarkdown>[1]> = {},
) {
  const wikiLinks: WikiLinkContext = {
    spaceSlug: "sp",
    docs: [],
    sections: [],
    from: { sectionSlug: "docs", path },
  };
  return renderMarkdown(md, { target: "web", wikiLinks, ...extra });
}

describe("hosted assets — images", () => {
  it("rewrites a relative image to the asset URL", async () => {
    const html = await render("![Flow](./img/flow.png)");
    expect(html).toContain('<img src="/a/sp/docs/guides/img/flow.png" alt="Flow">');
  });

  it("resolves a bare relative path the same way", async () => {
    const html = await render("![Flow](img/flow.png)");
    expect(html).toContain('src="/a/sp/docs/guides/img/flow.png"');
  });

  it("resolves from index.md against its own directory", async () => {
    const html = await render("![Flow](./img/flow.png)", "guides/index.md");
    expect(html).toContain('src="/a/sp/docs/guides/img/flow.png"');
  });

  it("resolves .. within the section", async () => {
    const html = await render("![Flow](../shared/flow.png)");
    expect(html).toContain('src="/a/sp/docs/shared/flow.png"');
  });

  it("leaves a reference that climbs out of the section as written", async () => {
    const html = await render("![Flow](../../flow.png)");
    expect(html).toContain('src="../../flow.png"');
  });

  it("leaves external and root-relative images alone", async () => {
    expect(await render("![x](https://example.com/a.png)"))
      .toContain('src="https://example.com/a.png"');
    expect(await render("![x](/static/a.png)")).toContain('src="/static/a.png"');
  });

  it("does nothing without a document to resolve against", async () => {
    const html = await renderMarkdown("![Flow](./img/flow.png)");
    expect(html).toContain('src="./img/flow.png"');
  });

  it("still refuses a data: image on the web path", async () => {
    const html = await render("![x](data:image/png;base64,AAAA)");
    expect(html).not.toContain("data:");
  });
});

describe("hosted assets — links", () => {
  it("opens a link to a hosted file in a new tab", async () => {
    const html = await render("[Spec](./spec.pdf)");
    expect(html).toContain(
      '<a href="/a/sp/docs/guides/spec.pdf" class="asset-link" target="_blank" rel="noopener">Spec</a>',
    );
  });

  it("keeps a fragment on the link", async () => {
    const html = await render("[Spec](./spec.pdf#page=3)");
    expect(html).toContain('href="/a/sp/docs/guides/spec.pdf#page=3"');
  });

  it("links straight to an image when it is a link target", async () => {
    const html = await render("[full size](./img/flow.png)");
    expect(html).toContain('href="/a/sp/docs/guides/img/flow.png"');
  });

  it("leaves a relative link to another document alone", async () => {
    const html = await render("[Other](./other.md)");
    expect(html).toContain('<a href="./other.md">Other</a>');
  });

  it("leaves external links alone", async () => {
    const html = await render("[Spec](https://example.com/spec.pdf)");
    expect(html).toContain('<a href="https://example.com/spec.pdf">Spec</a>');
  });

  it("turns image syntax around a PDF into a link", async () => {
    const html = await render("![The spec](./spec.pdf)");
    expect(html).not.toContain("<img");
    expect(html).toContain('href="/a/sp/docs/guides/spec.pdf"');
    expect(html).toContain(">The spec</a>");
  });

  it("labels that link with the file name when there is no alt text", async () => {
    const html = await render("![](./spec.pdf)");
    expect(html).toContain(">spec.pdf</a>");
  });
});

describe("hosted assets — pdf target", () => {
  const dataUri = "data:image/png;base64,AAAA";

  it("embeds an image through inlineAsset, by section-relative path", async () => {
    const asked: string[] = [];
    const html = await render("![Flow](./img/flow.png)", "guides/auth.md", {
      target: "pdf",
      inlineAsset: async (path) => {
        asked.push(path);
        return dataUri;
      },
    });
    expect(asked).toEqual(["guides/img/flow.png"]);
    expect(html).toContain(`<img alt="Flow" src="${dataUri}">`);
  });

  it("drops the src of an image that cannot be embedded, keeping the alt text", async () => {
    const html = await render("![Flow](./img/flow.png)", "guides/auth.md", {
      target: "pdf",
      inlineAsset: async () => null,
    });
    expect(html).toContain('<img alt="Flow">');
  });

  it("drops the src when no inliner is supplied", async () => {
    const html = await render("![Flow](./img/flow.png)", "guides/auth.md", { target: "pdf" });
    expect(html).toContain('<img alt="Flow">');
  });

  it("never embeds a PDF", async () => {
    const asked: string[] = [];
    const html = await render("![Spec](./spec.pdf)", "guides/auth.md", {
      target: "pdf",
      origin: "https://docs.example",
      inlineAsset: async (path) => {
        asked.push(path);
        return dataUri;
      },
    });
    expect(asked).toEqual([]);
    expect(html).toContain('href="https://docs.example/a/sp/docs/guides/spec.pdf"');
  });

  it("makes file links absolute with the origin", async () => {
    const html = await render("[Spec](./spec.pdf)", "guides/auth.md", {
      target: "pdf",
      origin: "https://docs.example",
    });
    expect(html).toContain('href="https://docs.example/a/sp/docs/guides/spec.pdf"');
  });

  it("leaves external images for WeasyPrint to fetch", async () => {
    const html = await render("![x](https://example.com/a.png)", "guides/auth.md", {
      target: "pdf",
      inlineAsset: async () => dataUri,
    });
    expect(html).toContain('src="https://example.com/a.png"');
  });
});
