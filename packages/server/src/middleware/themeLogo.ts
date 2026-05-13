/**
 * Theme logo upload validation.
 *
 * Theme logos are embedded into PDFs by WeasyPrint and served from
 * /api/themes/:id/logo. Both pipelines are unforgiving about
 * attacker-controlled file content:
 *
 * - SVG: can contain inline <script> and event handlers; serving SVG as
 *   image/svg+xml in a same-origin context executes JS even via <img> in
 *   some browsers when navigated to directly. Rejected outright; convert
 *   to PNG/WebP if you need a vector logo.
 * - Raster formats: validated by magic bytes (not by the attacker-supplied
 *   Content-Type header) and size-bounded.
 */

const MAX_LOGO_SIZE = 1024 * 1024; // 1 MB

type RasterFormat = "png" | "jpg" | "gif" | "webp";

interface ValidatedUpload {
  bytes: Uint8Array;
  mimeType: string;
  extension: RasterFormat;
}

interface ValidationError {
  error: string;
}

function magicMatches(bytes: Uint8Array): RasterFormat | null {
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

const MIME_BY_EXT: Record<RasterFormat, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export function validateLogoUpload(body: ArrayBuffer): ValidatedUpload | ValidationError {
  if (body.byteLength === 0) {
    return { error: "Empty body" };
  }
  if (body.byteLength > MAX_LOGO_SIZE) {
    return { error: `Logo too large (max ${MAX_LOGO_SIZE} bytes)` };
  }

  const bytes = new Uint8Array(body);
  const format = magicMatches(bytes);

  if (!format) {
    return {
      error:
        "Unsupported image format. Allowed: PNG, JPEG, GIF, WebP. SVG is " +
        "rejected because it can carry executable content.",
    };
  }

  return { bytes, mimeType: MIME_BY_EXT[format], extension: format };
}
