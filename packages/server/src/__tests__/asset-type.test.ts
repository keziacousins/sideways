import { describe, it, expect } from "vitest";
import { sniffMimeType, checkAssetUpload } from "../lib/asset-type.js";
import { validateAssetPath } from "../middleware/validate.js";

const text = (s: string) => new TextEncoder().encode(s);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = text("GIF89a......");
const WEBP = text("RIFF....WEBPVP8 ");
const PDF = text("%PDF-1.7\n%âãÏÓ\n");
const SVG = text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect/></svg>');

describe("sniffMimeType", () => {
  it("identifies each hosted type from its leading bytes", () => {
    expect(sniffMimeType(PNG)).toBe("image/png");
    expect(sniffMimeType(JPEG)).toBe("image/jpeg");
    expect(sniffMimeType(GIF)).toBe("image/gif");
    expect(sniffMimeType(WEBP)).toBe("image/webp");
    expect(sniffMimeType(PDF)).toBe("application/pdf");
    expect(sniffMimeType(SVG)).toBe("image/svg+xml");
  });

  it("finds an SVG behind the prologue drawing tools write", () => {
    const exported = text(
      // A byte-order mark, spelled out so the source holds no invisible character.
      String.fromCharCode(0xfeff) +
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        "<!-- Generator: Adobe Illustrator 27.0, SVG Export Plug-In -->\n" +
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [\n' +
        '  <!ENTITY ns_extend "http://ns.adobe.com/Extensibility/1.0/">\n' +
        "]>\n" +
        '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"></svg>',
    );
    expect(sniffMimeType(exported)).toBe("image/svg+xml");
  });

  it("does not take other markup or plain text for an SVG", () => {
    expect(sniffMimeType(text("<html><body>hello</body></html>"))).toBeNull();
    expect(sniffMimeType(text("just some text mentioning <svg> in passing"))).toBeNull();
    expect(sniffMimeType(text('<?xml version="1.0"?><note/>'))).toBeNull();
  });

  it("returns null for bytes of no hosted type", () => {
    expect(sniffMimeType(text("PK\u0003\u0004 a zip archive"))).toBeNull();
    expect(sniffMimeType(new Uint8Array(0))).toBeNull();
  });
});

describe("checkAssetUpload", () => {
  it("accepts bytes that are what the extension names", () => {
    expect(checkAssetUpload("img/a.png", PNG)).toEqual({ mimeType: "image/png" });
    expect(checkAssetUpload("img/a.jpeg", JPEG)).toEqual({ mimeType: "image/jpeg" });
    expect(checkAssetUpload("img/a.SVG", SVG)).toEqual({ mimeType: "image/svg+xml" });
    expect(checkAssetUpload("spec.pdf", PDF)).toEqual({ mimeType: "application/pdf" });
  });

  it("refuses bytes of a different type than the extension names", () => {
    // The uploader picks the name. A PDF called .png must not be stored as
    // either: served as a PNG it's broken, served as a PDF the name lied.
    expect(checkAssetUpload("img/a.png", PDF)).toMatchObject({ status: 415 });
    expect(checkAssetUpload("img/a.svg", text("<script>alert(1)</script>"))).toMatchObject({ status: 415 });
    expect(checkAssetUpload("spec.pdf", PNG)).toMatchObject({ status: 415 });
  });

  it("refuses an extension that isn't hosted", () => {
    expect(checkAssetUpload("archive.zip", PNG)).toMatchObject({ status: 415 });
  });

  it("refuses an empty body", () => {
    expect(checkAssetUpload("img/a.png", new Uint8Array(0))).toMatchObject({ status: 400 });
  });

  it("caps images at 10 MB and PDFs at 20 MB", () => {
    const sized = (head: Uint8Array, bytes: number) => {
      const out = new Uint8Array(bytes);
      out.set(head);
      return out;
    };
    const MB = 1024 * 1024;
    expect(checkAssetUpload("a.png", sized(PNG, 10 * MB))).toEqual({ mimeType: "image/png" });
    expect(checkAssetUpload("a.png", sized(PNG, 10 * MB + 1))).toMatchObject({ status: 413 });
    expect(checkAssetUpload("a.pdf", sized(PDF, 20 * MB))).toEqual({ mimeType: "application/pdf" });
    expect(checkAssetUpload("a.pdf", sized(PDF, 20 * MB + 1))).toMatchObject({ status: 413 });
  });
});

describe("validateAssetPath", () => {
  it("accepts a filesystem-shaped path with a hosted extension", () => {
    expect(validateAssetPath("flow.png")).toBeNull();
    expect(validateAssetPath("guides/img/flow-2.v1.PNG")).toBeNull();
  });

  it("rejects extensions that aren't hosted, including .md", () => {
    expect(validateAssetPath("notes.md")).not.toBeNull();
    expect(validateAssetPath("archive.zip")).not.toBeNull();
    expect(validateAssetPath("noextension")).not.toBeNull();
  });

  it("rejects traversal, empty segments and unsafe characters", () => {
    expect(validateAssetPath("../flow.png")).not.toBeNull();
    expect(validateAssetPath("img//flow.png")).not.toBeNull();
    expect(validateAssetPath("/img/flow.png")).not.toBeNull();
    expect(validateAssetPath("img/my flow.png")).not.toBeNull();
    expect(validateAssetPath('img/"flow.png')).not.toBeNull();
  });
});
