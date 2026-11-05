/**
 * One Typst render worker. server.mjs forks a small pool of these and talks to
 * them over the IPC channel; see the header there for why they are separate
 * processes at all.
 *
 * Protocol (one job at a time — the server never sends a second before the
 * first is answered):
 *
 *   ← { type: "ready" }                               once the compiler is up
 *   → { id, source, assets: [{ path, data }] }        data is base64
 *   ← { id, ok: true, svg, width, height }            width/height in pt
 *   ← { id, ok: false, error, diagnostics }           the diagram is at fault
 *
 * The sandbox is the environment the server starts us in, not anything done
 * here: no network (dead proxy), packages from the vendored cache only, and a
 * workspace that is an empty directory, so file reads find nothing on disk.
 * Assets reach the compiler in memory (`mapShadow`) and are unmapped again
 * after every job, so one diagram never sees another's files.
 */

import { readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeCompiler } from "@myriaddreamin/typst-ts-node-compiler";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = process.env.TYPST_WORKSPACE;
if (!workspace) throw new Error("TYPST_WORKSPACE is not set");

const fontPaths = (process.env.TYPST_FONT_PATHS || "").split(delimiter).filter(Boolean);
const compiler = NodeCompiler.create({
  workspace,
  fontArgs: fontPaths.length ? [{ fontPaths }] : [],
});

// The prelude lives at a fixed in-memory path; the diagram's own source goes
// after a two-line header that imports and applies it. Diagnostics are moved
// back by PREFIX_LINES so they point at the author's lines, not ours.
const PRELUDE_PATH = join(workspace, "sideways", "prelude.typ");
const MAIN_PATH = join(workspace, "main.typ");
compiler.addSource(PRELUDE_PATH, readFileSync(join(here, "prelude.typ"), "utf8"));
const PREFIX = '#import "/sideways/prelude.typ": *\n#show: diagram-setup\n';
const PREFIX_LINES = 2;

// The compiler caches parsed sources and layout across compiles. That is most
// of why a warm render takes a millisecond, but it also grows without bound
// across many different diagrams, so trim entries not used recently.
const EVICT_EVERY = 50;
const EVICT_MAX_AGE = 30;
let jobs = 0;

/** A diagnostic, with its position in the author's terms where it has one. */
function describe(d) {
  const out = { message: d.message };
  if (d.hints?.length) out.hints = d.hints;
  const start = d.range?.start;
  if (d.path === MAIN_PATH && start && start.line >= PREFIX_LINES) {
    // 1-based, as an editor shows them.
    out.line = start.line - PREFIX_LINES + 1;
    out.column = start.character + 1;
  } else if (d.package) {
    out.package = d.package;
  }
  return out;
}

/** `width="120.5pt"` on the root `<svg>` → 120.5. */
function rootDimension(svg, name) {
  const match = svg.slice(0, 600).match(new RegExp(`\\s${name}="([\\d.]+)pt"`));
  return match ? Number(match[1]) : undefined;
}

function render({ source, assets = [] }) {
  const mapped = [];
  try {
    for (const asset of assets) {
      const path = join(workspace, "assets", asset.path);
      compiler.mapShadow(path, Buffer.from(asset.data, "base64"));
      mapped.push(path);
    }

    compiler.addSource(MAIN_PATH, PREFIX + source);
    const result = compiler.compile({ mainFilePath: MAIN_PATH });
    const error = result.takeError();
    if (error) {
      const diagnostics = compiler.fetchDiagnostics(error).map(describe);
      return { ok: false, error: diagnostics[0]?.message || "Diagram failed to compile", diagnostics };
    }

    const svg = compiler.plainSvg(result.result);
    return { ok: true, svg, width: rootDimension(svg, "width"), height: rootDimension(svg, "height") };
  } finally {
    for (const path of mapped) compiler.unmapShadow(path);
    if (++jobs % EVICT_EVERY === 0) compiler.evictCache(EVICT_MAX_AGE);
  }
}

process.on("message", (job) => {
  let reply;
  try {
    reply = render(job);
  } catch (e) {
    // The compiler threw rather than reporting diagnostics — treat it as the
    // diagram's fault too; the server has nothing better to say about it.
    reply = { ok: false, error: e?.message || String(e), diagnostics: [] };
  }
  process.send({ id: job.id, ...reply });
});

// The parent going away (crash, SIGKILL) must not leave us orphaned.
process.on("disconnect", () => process.exit(0));

process.send({ type: "ready" });
