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

import { sniffRaster, RASTER_MIME_TYPES, type RasterFormat } from "../lib/asset-type.js";

const MAX_LOGO_SIZE = 1024 * 1024; // 1 MB

interface ValidatedUpload {
  bytes: Uint8Array;
  mimeType: string;
  extension: RasterFormat;
}

interface ValidationError {
  error: string;
}

export function validateLogoUpload(body: ArrayBuffer): ValidatedUpload | ValidationError {
  if (body.byteLength === 0) {
    return { error: "Empty body" };
  }
  if (body.byteLength > MAX_LOGO_SIZE) {
    return { error: `Logo too large (max ${MAX_LOGO_SIZE} bytes)` };
  }

  const bytes = new Uint8Array(body);
  const format = sniffRaster(bytes);

  if (!format) {
    return {
      error:
        "Unsupported image format. Allowed: PNG, JPEG, GIF, WebP. SVG is " +
        "rejected because it can carry executable content.",
    };
  }

  return { bytes, mimeType: RASTER_MIME_TYPES[format], extension: format };
}
