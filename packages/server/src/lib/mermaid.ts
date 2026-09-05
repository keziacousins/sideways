/**
 * Client for the Mermaid sidecar (a headless browser that turns diagram
 * source into SVG). Only the PDF path uses it: WeasyPrint has no JS
 * runtime, so diagrams have to arrive already rendered. The web surface
 * keeps shipping the raw code block and renders in the reader's browser.
 *
 * Call `createMermaidRenderer()` once per PDF export and pass the result
 * into `renderMarkdown` as `renderMermaid` for `target: "pdf"` only. The
 * rehype plugin catches rejections and falls back to a code block, so an
 * unreachable sidecar — or a document that blows the budgets below —
 * degrades the diagram, never the whole document.
 */

import { env } from "../env.js";
import { logger } from "../logger.js";

/**
 * Mermaid config. Structurally identical to the browser-side config in the
 * web client — a diagram that lays out one way on screen and another in
 * print is worse than one that doesn't render at all. Colour and label size
 * are the two deliberate exceptions, each matched to its own medium.
 *
 * `htmlLabels: false` is load-bearing: it keeps Mermaid from emitting
 * <foreignObject>, which WeasyPrint cannot draw.
 */

/**
 * Label size, and so the size of the whole drawing: Mermaid sizes its boxes
 * to fit their text, which makes this the master control over how large a
 * diagram comes out.
 *
 * The printed page sets body text at 11pt and drops to 10pt for secondary
 * content (see pdf/print.css) — a diagram label being secondary content. The
 * SVG is placed at its intrinsic pixel size and CSS pixels are 3/4 of a
 * point, so 10pt is 13.33px. Mermaid's own default is 16px, which prints at
 * 12pt: larger than the body text it sits beside, which is what made
 * diagrams read as oversized.
 */
const PRINT_LABEL_PT = 10;
const LABEL_FONT_PX = PRINT_LABEL_PT / 0.75;

const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  fontSize: LABEL_FONT_PX,
  themeVariables: { fontSize: `${LABEL_FONT_PX}px` },
};

/** A diagram slower than this is broken, not busy. */
const RENDER_TIMEOUT_MS = 8000;

/**
 * Per-document budgets. The sidecar is a single shared instance and each
 * render spawns a headless-browser page, so one export must not be able to
 * monopolise it: a 500 KB document can hold thousands of tiny diagrams, and
 * without a shared deadline a merely-slow sidecar would keep a single
 * request grinding long past nginx's 120s proxy timeout.
 */
const MAX_DIAGRAMS_PER_DOC = 50;
const DOC_BUDGET_MS = 30_000;
const MAX_CONCURRENT = 4;

/** Run at most `max` tasks at once, queueing the rest in call order. */
function createLimiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** Render Mermaid source to an SVG string. Rejects on failure. */
async function renderOne(code: string, timeoutMs: number): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${env.mermaidUrl}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, config: MERMAID_CONFIG }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    const reason = e?.name === "TimeoutError"
      ? `Mermaid render timed out after ${timeoutMs}ms`
      : `Mermaid service unavailable: ${e.message}`;
    logger.warn({ err: e.message, url: env.mermaidUrl }, reason);
    throw new Error(reason);
  }

  if (!res.ok) {
    // The sidecar reports diagram syntax errors as {"error": "..."}.
    const detail = await res.text().catch(() => "");
    let message = detail;
    try {
      message = JSON.parse(detail).error || detail;
    } catch {}
    throw new Error(`Mermaid render failed (${res.status}): ${message}`);
  }

  const body = (await res.json()) as { svg?: string };
  if (!body.svg) throw new Error("Mermaid service returned no SVG");
  return body.svg;
}

/**
 * Build a renderer scoped to one document render. It caps how many diagrams
 * a single export may push at the sidecar, shares one wall-clock deadline
 * across all of them, and keeps only a few in flight at a time. Diagrams
 * past a budget reject, which the rehype plugin turns into the plain code
 * block it would have emitted for the web target.
 */
export function createMermaidRenderer(): (code: string) => Promise<string> {
  const limit = createLimiter(MAX_CONCURRENT);
  const deadline = Date.now() + DOC_BUDGET_MS;
  let requested = 0;

  return async (code: string) => {
    if (++requested > MAX_DIAGRAMS_PER_DOC) {
      throw new Error(
        `Too many Mermaid diagrams in one document (limit ${MAX_DIAGRAMS_PER_DOC})`,
      );
    }

    return limit(async () => {
      // Checked inside the limiter, not outside: a diagram that waited out
      // the whole budget in the queue should give up rather than start.
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Mermaid render budget of ${DOC_BUDGET_MS}ms exhausted for this document`);
      }
      return renderOne(code, Math.min(RENDER_TIMEOUT_MS, remaining));
    });
  };
}
