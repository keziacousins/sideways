/**
 * Identify an upload from its bytes.
 *
 * The Content-Type header and the filename are both chosen by the uploader,
 * so neither decides how a file is stored or served — the leading bytes do.
 */

import { assetMimeType } from "@sideways/types";

export type RasterFormat = "png" | "jpg" | "gif" | "webp";

export const RASTER_MIME_TYPES: Record<RasterFormat, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export function sniffRaster(bytes: Uint8Array): RasterFormat | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "png";
  }
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpg";
  }
  // GIF: 47 49 46 38 [37|39] 61
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) {
    return "gif";
  }
  // WebP: "RIFF" (52 49 46 46) ... "WEBP" (57 45 42 50)
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

// PDF: "%PDF-"
function isPdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

/**
 * SVG has no magic number, so this reads the head as text: it has to open
 * like an XML document and reach an `<svg` tag within the first few KB (past
 * the XML declaration, the doctype and the generator comment that drawing
 * tools write first).
 *
 * Loose on purpose. A file that passes without being a real SVG is still
 * served as `image/svg+xml` under a sandboxing CSP with `nosniff`, so the
 * worst it can do is fail to draw.
 */
function isSvg(bytes: Uint8Array): boolean {
  // TextDecoder drops a leading byte-order mark on its own.
  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 4096)).trimStart();
  return /^<(\?xml|!--|!doctype|svg)/i.test(head) && /<svg[\s>]/i.test(head);
}

/** MIME type the bytes are, or null if they are not a hosted file type. */
export function sniffMimeType(bytes: Uint8Array): string | null {
  const raster = sniffRaster(bytes);
  if (raster) return RASTER_MIME_TYPES[raster];
  if (isPdf(bytes)) return "application/pdf";
  if (isSvg(bytes)) return "image/svg+xml";
  return null;
}

const MB = 1024 * 1024;

/** nginx caps request bodies at 20 MB; a PDF may use all of it. */
export const MAX_ASSET_SIZE = 20 * MB;
const MAX_IMAGE_SIZE = 10 * MB;

export type AssetCheck =
  | { mimeType: string }
  | { error: string; status: 400 | 413 | 415 };

/**
 * Decide whether `bytes` may be stored at `path`. The extension has to name
 * a hosted type and the bytes have to be of that type — an `.png` that is
 * really a PDF is refused rather than stored under either name.
 */
export function checkAssetUpload(path: string, bytes: Uint8Array): AssetCheck {
  if (bytes.length === 0) return { error: "Empty body", status: 400 };

  const expected = assetMimeType(path);
  if (!expected) {
    return { error: "Unsupported file type. Allowed: PNG, JPEG, GIF, WebP, SVG, PDF.", status: 415 };
  }

  const limit = expected === "application/pdf" ? MAX_ASSET_SIZE : MAX_IMAGE_SIZE;
  if (bytes.length > limit) {
    return { error: `File too large (max ${limit / MB} MB)`, status: 413 };
  }

  const actual = sniffMimeType(bytes);
  if (actual !== expected) {
    return {
      error: `File content is not ${expected}, which its extension names`,
      status: 415,
    };
  }

  return { mimeType: expected };
}
