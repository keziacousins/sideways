/**
 * Client for the Typst sidecar (infra/typst), which compiles ```typst diagram
 * fences to SVG in sandboxed, killable worker processes (see issue #117).
 *
 * Unlike mermaid, this runs on every path — Typst only renders on the server.
 * Build one renderer per document render with `createTypstRenderer` and pass
 * its `render` as `renderTypst`. Two modes, by where the `<img>` should point:
 *
 *   - "store": the cached web view. The SVG goes to storage under a key
 *     derived from the source, and the `<img>` points at it through
 *     /d/<space>/<hash>.svg. Content-addressed, so the cached HTML that holds
 *     the URL never goes stale and an unchanged diagram is never re-rendered.
 *   - "inline": the PDF (WeasyPrint can't fetch an access-controlled URL) and
 *     editor previews (no point storing every keystroke). The SVG travels in
 *     a `data:` URI.
 *
 * A rejection is turned into a code block plus a note by the rehype plugin.
 * Rejections caused by us rather than the diagram — sidecar down, timed out,
 * busy, storage failing — set `transientFailure`, so the caller can decline
 * to cache HTML that would otherwise show the outage forever.
 */

import { createHash } from "node:crypto";
import type { Storage } from "@sideways/storage";
import type { TypstDiagram } from "@sideways/markdown";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { createLimiter } from "./limiter.js";

/**
 * Part of every stored diagram's key. Bump it whenever output for the same
 * source changes: infra/typst/prelude.typ, the vendored package versions, the
 * fonts in the image, or the Typst compiler itself.
 */
export const PRELUDE_VERSION = "p1";

/** The sidecar's own deadline is 8s; allow for queueing and transfer. */
const RENDER_TIMEOUT_MS = 10_000;
const MAX_DIAGRAMS_PER_DOC = 50;
const DOC_BUDGET_MS = 30_000;
/** Matches the sidecar's default pool, so one document doesn't queue on itself. */
const MAX_CONCURRENT = 2;

/** CSS px per pt: the sidecar reports Typst's page size in points. */
const PX_PER_PT = 4 / 3;

interface SidecarDiagnostic {
  message: string;
  line?: number;
  column?: number;
  hints?: string[];
  package?: string;
}

/** The diagram's own fault; deterministic, so safe to cache. */
class DiagramError extends Error {}

/**
 * The compiler's complaints as one line for the note under the source, most
 * useful first: located errors carry "line L, column C".
 */
export function formatDiagnostics(error: string, diagnostics: SidecarDiagnostic[] = []): string {
  if (diagnostics.length === 0) return error;
  return diagnostics
    .slice(0, 3)
    .map((d) => {
      const where = d.line ? `line ${d.line}, column ${d.column}: ` : d.package ? `in ${d.package}: ` : "";
      const hints = d.hints?.length ? ` (hint: ${d.hints.join("; ")})` : "";
      return `${where}${d.message}${hints}`;
    })
    .join("; ");
}

interface Rendered {
  svg: string;
  width?: number;
  height?: number;
}

async function renderOne(source: string, timeoutMs: number): Promise<Rendered> {
  let res: Response;
  try {
    res = await fetch(`${env.typstUrl}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    const reason = e?.name === "TimeoutError"
      ? `Typst render timed out after ${timeoutMs}ms`
      : `Typst service unavailable: ${e.message}`;
    logger.warn({ err: e.message, url: env.typstUrl }, reason);
    throw new Error(reason);
  }

  const body = (await res.json().catch(() => ({}))) as {
    svg?: string;
    width?: number;
    height?: number;
    error?: string;
    diagnostics?: SidecarDiagnostic[];
  };
  if (res.status === 422) throw new DiagramError(formatDiagnostics(body.error ?? "Diagram failed to compile", body.diagnostics));
  if (!res.ok) throw new Error(`Typst render failed (${res.status}): ${body.error ?? "unknown error"}`);
  if (!body.svg) throw new Error("Typst service returned no SVG");
  return { svg: body.svg, width: body.width, height: body.height };
}

function px(pt: number | undefined): number | undefined {
  return pt ? pt * PX_PER_PT : undefined;
}

/** Content address of a diagram: what it says, and what it was rendered with. */
export function diagramKey(source: string): string {
  return createHash("sha256").update(`${PRELUDE_VERSION}\0${source}`).digest("hex");
}

/** Where a stored diagram lives, per space so access follows the space's. */
export function diagramStoragePath(spaceId: string, key: string): string {
  return `/diagrams/${spaceId}/${key}.svg`;
}

/** The URL a rendered page points at; the web app proxies it to the API. */
export function diagramUrl(spaceSlug: string, key: string): string {
  return `/d/${encodeURIComponent(spaceSlug)}/${key}.svg`;
}

export type TypstRendererMode =
  | { kind: "inline" }
  | { kind: "store"; storage: Storage; spaceId: string; spaceSlug: string };

export interface TypstRenderer {
  render: (source: string) => Promise<TypstDiagram>;
  /** True once any diagram failed for a reason that isn't the diagram's. */
  readonly transientFailure: boolean;
}

/**
 * A renderer scoped to one document render: a diagram cap, one shared
 * deadline and a small concurrency limit, as for mermaid.
 */
export function createTypstRenderer(mode: TypstRendererMode): TypstRenderer {
  const limit = createLimiter(MAX_CONCURRENT);
  const deadline = Date.now() + DOC_BUDGET_MS;
  let requested = 0;
  let transientFailure = false;

  async function compile(source: string): Promise<Rendered> {
    return limit(async () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Typst render budget of ${DOC_BUDGET_MS}ms exhausted for this document`);
      return renderOne(source, Math.min(RENDER_TIMEOUT_MS, remaining));
    });
  }

  async function render(source: string): Promise<TypstDiagram> {
    if (++requested > MAX_DIAGRAMS_PER_DOC) {
      // Deterministic for a given document, so not transient.
      throw new Error(`Too many Typst diagrams in one document (limit ${MAX_DIAGRAMS_PER_DOC})`);
    }

    try {
      if (mode.kind === "inline") {
        const { svg, width, height } = await compile(source);
        return {
          src: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
          width: px(width),
          height: px(height),
        };
      }

      const key = diagramKey(source);
      const path = diagramStoragePath(mode.spaceId, key);
      const src = diagramUrl(mode.spaceSlug, key);
      // Rendered before (this document or another in the space): reuse it. The
      // image's natural size comes from the SVG itself, so the dimensions only
      // ride along when we have them to hand.
      if (await mode.storage.exists(path)) return { src };

      const { svg, width, height } = await compile(source);
      // Awaited, not fire-and-forget: the HTML about to be cached points here.
      await mode.storage.upload(path, Buffer.from(svg), "image/svg+xml");
      return { src, width: px(width), height: px(height) };
    } catch (e) {
      if (!(e instanceof DiagramError)) transientFailure = true;
      throw e;
    }
  }

  return {
    render,
    get transientFailure() {
      return transientFailure;
    },
  };
}
