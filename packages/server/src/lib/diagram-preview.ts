/**
 * Previews of a single Typst diagram, for whoever is authoring it (issue #124).
 *
 * An agent writing a diagram through MCP can't see SVG, so the diagram is
 * compiled the way a document render would compile it — the space's theme
 * fonts, the document's images — and rasterised to PNG here. The compiler's
 * errors and warnings come back alongside, which is most of what an author
 * needs to fix a diagram.
 */

import { Resvg } from "@resvg/resvg-js";
import { createTypstRenderer, type TypstDocument, type TypstFontContext } from "./typst.js";

/** Pixels per CSS px: 2x, so small labels stay legible. */
const SCALE = 2;
/** Longest side of the PNG; a model gains nothing from a bigger image. */
const MAX_SIDE_PX = 2000;

export type DiagramPreview =
  | { ok: true; png: Buffer; width: number; height: number; warnings: string[] }
  /** The diagram's own fault: what the compiler said. */
  | { ok: false; error: string; warnings: string[] }
  /** Not the diagram's fault (sidecar down or busy); worth trying again. */
  | { ok: false; transient: true; error: string };

/** The SVG inside a `data:image/svg+xml;base64,…` URI. */
function svgFromDataUri(src: string): string {
  const comma = src.indexOf(",");
  return Buffer.from(src.slice(comma + 1), "base64").toString("utf8");
}

/** Rasterise a Typst SVG to PNG, at SCALE but no bigger than MAX_SIDE_PX. */
export function rasterise(svg: string): { png: Buffer; width: number; height: number } {
  const natural = new Resvg(svg);
  const longest = Math.max(natural.width, natural.height);
  const scale = Math.min(SCALE, MAX_SIDE_PX / Math.max(longest, 1));
  // A white background: diagrams are drawn for the page, and a transparent
  // PNG shows black on some viewers.
  const rendered = new Resvg(svg, {
    fitTo: { mode: "zoom", value: scale },
    background: "white",
  }).render();
  return { png: rendered.asPng(), width: rendered.width, height: rendered.height };
}

export async function previewDiagram(
  source: string,
  fonts: TypstFontContext,
  doc: TypstDocument,
): Promise<DiagramPreview> {
  // Inline: a preview is thrown away, so there's nothing worth storing.
  const typst = createTypstRenderer({ kind: "inline" }, fonts, doc);
  let src: string;
  try {
    ({ src } = await typst.render(source));
  } catch (e: any) {
    if (typst.transientFailure) return { ok: false, transient: true, error: e.message };
    return { ok: false, error: e.message, warnings: typst.warnings };
  }
  return { ok: true, ...rasterise(svgFromDataUri(src)), warnings: typst.warnings };
}
