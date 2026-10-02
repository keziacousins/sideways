import { describe, it, expect } from "vitest";
import { assetUrl, assetMimeType, resolveRelativePath } from "../index.js";

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
