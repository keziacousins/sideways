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
import { posix } from "node:path";
import { eq } from "drizzle-orm";
import { type Database, themes } from "@sideways/db";
import type { Storage } from "@sideways/storage";
import { typstAssetRefs, type TypstDiagram } from "@sideways/markdown";
import { isValidFont } from "@sideways/theme";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { createLimiter } from "./limiter.js";
import { findAssetByPath } from "./assets.js";

/**
 * Part of every stored diagram's key. Bump it whenever output for the same
 * source changes: infra/typst/prelude.typ, the vendored package versions, the
 * fonts in the image, or the Typst compiler itself.
 */
//
// p2: default fonts Inter / Newsreader / Fira Code; theme fonts.
// p3: static EB Garamond and Oswald; clients' static typst/ instances.
// Also part of the rendered-HTML cache key (routes/documents.ts).
export const PRELUDE_VERSION = "p3";

/** The sidecar's own deadline is 8s; allow for queueing and transfer. */
const RENDER_TIMEOUT_MS = 10_000;
const MAX_DIAGRAMS_PER_DOC = 50;
const DOC_BUDGET_MS = 30_000;
/** Matches the sidecar's default pool, so one document doesn't queue on itself. */
const MAX_CONCURRENT = 2;

/** All the images one diagram may read, together (they travel base64-encoded). */
const MAX_DIAGRAM_ASSET_BYTES = 5 * 1024 * 1024;

/** CSS px per pt: the sidecar reports Typst's page size in points. */
const PX_PER_PT = 4 / 3;

/**
 * The fonts a space's diagrams are drawn with, from its theme. Sent with every
 * render and part of every stored diagram's key: the same source draws
 * differently in a space with different type.
 *
 *   - fontSets: the brand font directories (by client name) the theme's own
 *     fonts come from. The sidecar gives a diagram those and the defaults,
 *     nothing else, so one client's licensed face can't be named into a
 *     diagram in another space.
 *   - inputs: the theme's body, display and mono families, which the prelude
 *     makes the diagram's defaults.
 */
export interface TypstFontContext {
  fontSets: string[];
  inputs: Record<string, string>;
}

export const NO_THEME_FONTS: TypstFontContext = { fontSets: [], inputs: {} };

// A theme's custom fonts are served from /fonts/<client>/<file> (see
// scripts/sync-brand-assets.sh), and the same <client> names the directory the
// sidecar holds them in.
const BRAND_FONT_SRC_RE = /^\/fonts\/([A-Za-z0-9][A-Za-z0-9._-]*)\//;

/** The font context for a theme's tokens; tolerant of whatever is stored. */
export function typstFontContext(tokens: unknown): TypstFontContext {
  const fonts = (tokens as { fonts?: Record<string, unknown> } | null | undefined)?.fonts;
  if (!fonts || typeof fonts !== "object") return NO_THEME_FONTS;

  const fontSets = new Set<string>();
  for (const custom of Array.isArray(fonts.custom) ? fonts.custom : []) {
    const match = typeof custom?.src === "string" ? BRAND_FONT_SRC_RE.exec(custom.src) : null;
    if (match) fontSets.add(match[1]);
  }

  const inputs: Record<string, string> = {};
  for (const [token, input] of [["body", "font-body"], ["display", "font-display"], ["mono", "font-mono"]] as const) {
    const family = fonts[token];
    if (typeof family === "string" && isValidFont(family.trim())) inputs[input] = family.trim();
  }

  return { fontSets: [...fontSets].sort(), inputs };
}

/** The font context for a space with this theme (or none). */
export async function themeFontContext(db: Database, themeId: string | null | undefined): Promise<TypstFontContext> {
  if (!themeId) return NO_THEME_FONTS;
  const row = await db.query.themes.findFirst({ where: eq(themes.id, themeId), columns: { tokens: true } });
  return typstFontContext(row?.tokens);
}

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
  warnings: SidecarDiagnostic[];
}

/** One of the space's hosted files, as a diagram reads it. */
export interface TypstAsset {
  contentHash: string;
  load: () => Promise<Buffer>;
}

/**
 * The document a diagram sits in, so it can read the space's hosted files the
 * way the markdown around it does: `image("./img/logo.png")`, relative to the
 * document, nothing outside its section (see typstAssetRefs).
 */
export interface TypstDocument {
  /** Section-relative path of the document, e.g. "guides/arch.md". */
  docPath: string;
  /** A section-relative asset path to the file, or null if there's none. */
  findAsset: (path: string) => Promise<TypstAsset | null>;
}

/** A TypstDocument over the space's stored assets. */
export function typstDocument(
  db: Database,
  storage: Storage,
  spaceId: string,
  sectionId: string,
  docPath: string,
): TypstDocument {
  return {
    docPath,
    async findAsset(path) {
      const row = await findAssetByPath(db, spaceId, sectionId, path);
      if (!row) return null;
      return {
        contentHash: row.contentHash,
        load: async () => Buffer.from(await (await storage.download(row.storageKey)).arrayBuffer()),
      };
    },
  };
}

interface SidecarAsset {
  path: string;
  data: string;
}

async function renderOne(
  source: string,
  fonts: TypstFontContext,
  files: { mainDir: string; assets: SidecarAsset[] },
  timeoutMs: number,
): Promise<Rendered> {
  let res: Response;
  try {
    res = await fetch(`${env.typstUrl}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, mainDir: files.mainDir, assets: files.assets, fontSets: fonts.fontSets, inputs: fonts.inputs }),
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
    warnings?: SidecarDiagnostic[];
  };
  if (res.status === 422) throw new DiagramError(formatDiagnostics(body.error ?? "Diagram failed to compile", body.diagnostics));
  if (!res.ok) throw new Error(`Typst render failed (${res.status}): ${body.error ?? "unknown error"}`);
  if (!body.svg) throw new Error("Typst service returned no SVG");
  return { svg: body.svg, width: body.width, height: body.height, warnings: body.warnings ?? [] };
}

function px(pt: number | undefined): number | undefined {
  return pt ? pt * PX_PER_PT : undefined;
}

/**
 * Content address of a diagram: what it says, and what it was rendered with —
 * the prelude, the fonts, and the content of every file it reads, so that
 * replacing an image re-renders the diagrams that show it.
 */
export function diagramKey(
  source: string,
  fonts: TypstFontContext = NO_THEME_FONTS,
  assets: Array<[path: string, contentHash: string]> = [],
): string {
  const context = JSON.stringify([fonts.fontSets, Object.entries(fonts.inputs).sort(), [...assets].sort()]);
  return createHash("sha256").update(`${PRELUDE_VERSION}\0${context}\0${source}`).digest("hex");
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
  /**
   * The compiler's warnings for diagrams rendered here (e.g. a font family it
   * couldn't find), formatted like errors. Not shown in the document; for
   * tools that preview a diagram for its author.
   */
  readonly warnings: string[];
}

/**
 * A renderer scoped to one document render: a diagram cap, one shared
 * deadline and a small concurrency limit, as for mermaid.
 */
export function createTypstRenderer(
  mode: TypstRendererMode,
  fonts: TypstFontContext = NO_THEME_FONTS,
  doc?: TypstDocument,
): TypstRenderer {
  const limit = createLimiter(MAX_CONCURRENT);
  const deadline = Date.now() + DOC_BUDGET_MS;
  let requested = 0;
  let transientFailure = false;
  const warnings: string[] = [];

  // The document's directory within its section, where the diagram "lives".
  const mainDir = doc ? posix.dirname(doc.docPath).replace(/^\.$/, "") : "";

  /** The hosted files a diagram reads that exist; missing ones are left to Typst to report. */
  async function findAssets(source: string): Promise<Array<[string, TypstAsset]>> {
    if (!doc) return [];
    const refs = typstAssetRefs(source, doc.docPath);
    const found = await Promise.all(refs.map(async (path) => [path, await doc.findAsset(path)] as const));
    return found.filter((entry): entry is [string, TypstAsset] => entry[1] !== null);
  }

  async function loadAssets(assets: Array<[string, TypstAsset]>): Promise<SidecarAsset[]> {
    const loaded = await Promise.all(assets.map(async ([path, asset]) => [path, await asset.load()] as const));
    const total = loaded.reduce((sum, [, bytes]) => sum + bytes.length, 0);
    if (total > MAX_DIAGRAM_ASSET_BYTES) {
      throw new DiagramError(`The diagram's images come to ${Math.round(total / 1024 / 1024)}MB; at most ${MAX_DIAGRAM_ASSET_BYTES / 1024 / 1024}MB per diagram`);
    }
    return loaded.map(([path, bytes]) => ({ path, data: bytes.toString("base64") }));
  }

  async function compile(source: string, assets: Array<[string, TypstAsset]>): Promise<Rendered> {
    const files = { mainDir, assets: await loadAssets(assets) };
    const rendered = await limit(async () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Typst render budget of ${DOC_BUDGET_MS}ms exhausted for this document`);
      return renderOne(source, fonts, files, Math.min(RENDER_TIMEOUT_MS, remaining));
    });
    if (rendered.warnings.length) warnings.push(formatDiagnostics("", rendered.warnings));
    return rendered;
  }

  async function render(source: string): Promise<TypstDiagram> {
    if (++requested > MAX_DIAGRAMS_PER_DOC) {
      // Deterministic for a given document, so not transient.
      throw new Error(`Too many Typst diagrams in one document (limit ${MAX_DIAGRAMS_PER_DOC})`);
    }

    try {
      const assets = await findAssets(source);
      if (mode.kind === "inline") {
        const { svg, width, height } = await compile(source, assets);
        return {
          src: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
          width: px(width),
          height: px(height),
        };
      }

      const key = diagramKey(source, fonts, assets.map(([path, asset]) => [path, asset.contentHash]));
      const path = diagramStoragePath(mode.spaceId, key);
      const src = diagramUrl(mode.spaceSlug, key);
      // Rendered before (this document or another in the space): reuse it. The
      // image's natural size comes from the SVG itself, so the dimensions only
      // ride along when we have them to hand.
      if (await mode.storage.exists(path)) return { src };

      const { svg, width, height } = await compile(source, assets);
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
    warnings,
  };
}
