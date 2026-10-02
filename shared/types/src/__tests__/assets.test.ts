import { describe, it, expect } from "vitest";
import { assetUrl, assetMimeType, resolveRelativePath, resolveRelativeRef } from "../index.js";

describe("assetUrl", () => {
  it("keeps the extension and the directory structure", () => {
    expect(assetUrl({ spaceSlug: "shikasta", sectionSlug: "docs", path: "guides/img/flow.png" }))
      .toBe("/a/shikasta/docs/guides/img/flow.png");
  });

  it("URL-encodes segments containing reserved characters", () => {
    expect(assetUrl({ spaceSlug: "my space", sectionSlug: "a/b", path: "p&q/x y.png" }))
      .toBe("/a/my%20space/a%2Fb/p%26q/x%20y.png");
  });
});

describe("assetMimeType", () => {
  it("names the type for each hosted extension", () => {
    expect(assetMimeType("a.png")).toBe("image/png");
    expect(assetMimeType("a.jpg")).toBe("image/jpeg");
    expect(assetMimeType("a.jpeg")).toBe("image/jpeg");
    expect(assetMimeType("a.gif")).toBe("image/gif");
    expect(assetMimeType("a.webp")).toBe("image/webp");
    expect(assetMimeType("a.svg")).toBe("image/svg+xml");
    expect(assetMimeType("a.pdf")).toBe("application/pdf");
  });

  it("ignores the extension's case", () => {
    expect(assetMimeType("img/Screenshot.PNG")).toBe("image/png");
  });

  it("looks at the file name only, not at dots in directories", () => {
    expect(assetMimeType("v1.png/notes")).toBeNull();
  });

  it("returns null for anything that isn't a hosted type", () => {
    expect(assetMimeType("notes.md")).toBeNull();
    expect(assetMimeType("archive.zip")).toBeNull();
    expect(assetMimeType("png")).toBeNull();
    expect(assetMimeType(".png")).toBeNull();
  });
});

describe("resolveRelativePath", () => {
  it("resolves against the document's directory", () => {
    expect(resolveRelativePath("guides/auth.md", "./img/flow.png")).toBe("guides/img/flow.png");
    expect(resolveRelativePath("guides/auth.md", "img/flow.png")).toBe("guides/img/flow.png");
    expect(resolveRelativePath("auth.md", "flow.png")).toBe("flow.png");
  });

  it("treats index.md like any other file in its directory", () => {
    // The case the browser gets wrong: the doc's URL is `/…/guides`, with no
    // trailing slash, so it would resolve this one directory too high.
    expect(resolveRelativePath("guides/index.md", "./img/flow.png")).toBe("guides/img/flow.png");
  });

  it("climbs with ..", () => {
    expect(resolveRelativePath("guides/deep/auth.md", "../img/flow.png")).toBe("guides/img/flow.png");
    expect(resolveRelativePath("guides/auth.md", "../flow.png")).toBe("flow.png");
  });

  it("refuses to climb out of the section root", () => {
    expect(resolveRelativePath("auth.md", "../flow.png")).toBeNull();
    expect(resolveRelativePath("guides/auth.md", "../../flow.png")).toBeNull();
  });

  it("decodes percent-encoded segments", () => {
    expect(resolveRelativePath("auth.md", "img/my%20flow.png")).toBe("img/my flow.png");
  });

  it("refuses an encoded slash or a malformed escape", () => {
    expect(resolveRelativePath("auth.md", "img%2Fflow.png")).toBeNull();
    expect(resolveRelativePath("auth.md", "img/%zz.png")).toBeNull();
  });

  it("refuses an encoded .. that would climb out", () => {
    expect(resolveRelativePath("auth.md", "%2E%2E/flow.png")).toBeNull();
  });

  it("returns null for a root-relative or empty reference", () => {
    expect(resolveRelativePath("guides/auth.md", "/img/flow.png")).toBeNull();
    expect(resolveRelativePath("guides/auth.md", "")).toBeNull();
  });

  it("returns null for a reference that names a directory", () => {
    expect(resolveRelativePath("guides/auth.md", "./")).toBeNull();
    expect(resolveRelativePath("guides/auth.md", "img/")).toBeNull();
    expect(resolveRelativePath("guides/auth.md", "..")).toBeNull();
  });
});

describe("resolveRelativeRef", () => {
  it("stays in the linking document's section by default", () => {
    expect(resolveRelativeRef("guides/auth.md", "./intro.md"))
      .toEqual({ sectionSlug: null, path: "guides/intro.md" });
    expect(resolveRelativeRef("guides/auth.md", "../index.md"))
      .toEqual({ sectionSlug: null, path: "index.md" });
  });

  it("takes the first segment above the section root as a section slug", () => {
    expect(resolveRelativeRef("guides/auth.md", "../../platform/api.md"))
      .toEqual({ sectionSlug: "platform", path: "api.md" });
    expect(resolveRelativeRef("auth.md", "../platform/deep/api.md"))
      .toEqual({ sectionSlug: "platform", path: "deep/api.md" });
  });

  it("can climb out of one section and into a third", () => {
    expect(resolveRelativeRef("auth.md", "../platform/../ops/run.md"))
      .toEqual({ sectionSlug: "ops", path: "run.md" });
  });

  it("refuses to climb above the space", () => {
    expect(resolveRelativeRef("auth.md", "../../elsewhere/x.md")).toBeNull();
    expect(resolveRelativeRef("guides/auth.md", "../../../elsewhere/x.md")).toBeNull();
  });

  it("returns null when it names a section but no file in it", () => {
    expect(resolveRelativeRef("auth.md", "../platform")).toBeNull();
    expect(resolveRelativeRef("auth.md", "../platform/")).toBeNull();
    expect(resolveRelativeRef("auth.md", "..")).toBeNull();
  });
});

describe("resolveRelativePath, for references that may not leave the section", () => {
  it("returns null where resolveRelativeRef would cross into another section", () => {
    expect(resolveRelativePath("guides/auth.md", "../../platform/a.png")).toBeNull();
    expect(resolveRelativePath("auth.md", "../docs/a.png")).toBeNull();
  });
});
