/**
 * Minimal Mermaid rendering service.
 * Accepts diagram source via POST, returns an SVG string.
 *
 * This exists for the PDF surface only. WeasyPrint has no JS runtime, so
 * diagrams that the web surface renders in the reader's browser have to be
 * turned into SVG before the HTML ever reaches WeasyPrint. The renderer
 * decides which path to take from RenderOptions.target.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { createMermaidRenderer } from "mermaid-isomorphic";
import { chromium } from "playwright";

const PORT = Number(process.env.PORT || 5002);

// A diagram is user-authored text fed to a real layout engine. Mermaid has had
// pathological inputs before (huge graphs, cyclic layouts) and page.evaluate()
// has no timeout of its own, so the service enforces its own deadline.
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS || 20000);

// Bounds on what a single request may cost us before any browser work starts.
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CODE_LENGTH = 100_000;

// How many diagrams may be rendering at once, and how many may wait for a slot
// before we start shedding. The caller pushes a document's diagrams four at a
// time under an 8s per-diagram deadline, so the pool is sized to let one export
// through without queueing on itself; past the queue cap a caller is better off
// with an immediate 503 it can degrade on than a slot it will have abandoned by
// the time it arrives.
const MAX_CONCURRENT_RENDERS = Number(process.env.MAX_CONCURRENT_RENDERS || 4);
const MAX_QUEUED_RENDERS = Number(process.env.MAX_QUEUED_RENDERS || 8);

/**
 * The pinned Mermaid config. The caller sends its own copy of this (the same
 * object the browser bundle uses on the web surface); these are the defaults
 * for callers that don't, and the floor that callers can't lower.
 *
 * htmlLabels must stay false: html labels are emitted as <foreignObject>,
 * which WeasyPrint drops silently — the diagram would render with every label
 * missing rather than failing loudly.
 */
const DEFAULT_MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  htmlLabels: false,
  flowchart: { htmlLabels: false },
};

let browser;
let sharedContext;
let shuttingDown = false;

// The pages belonging to the render running on this async context. Several
// renders share the one browser context, so cancelling one means being able to
// tell its pages from everyone else's: AsyncLocalStorage carries the set from
// renderDiagram() through mermaid-isomorphic's internals to the newPage() call
// it makes on our behalf.
const renderPages = new AsyncLocalStorage();

async function trackedNewPage() {
  const page = await sharedContext.newPage();
  const pages = renderPages.getStore();
  pages?.add(page);
  page.once("close", () => pages?.delete(page));
  return page;
}

/**
 * A stand-in for playwright's `chromium` BrowserType, handed to
 * mermaid-isomorphic.
 *
 * createMermaidRenderer() owns its browser: it launches one on the first
 * render and closes it again as soon as no render is in flight. For a sidecar
 * that means a full Chromium cold start (~1s, plus the mermaid bundle parse)
 * on every single PDF export. Passing this object instead makes every
 * "launch" hand back the long-lived browser context this process started at
 * boot, and makes the library's close() calls no-ops — process shutdown owns
 * the real lifetime.
 *
 * mermaid-isomorphic@3.1.0 only ever calls browserType.launch(),
 * browser.newContext(), context.newPage() and close() on both, so this
 * duck-typed subset is enough. It is coupled to that version's internals,
 * hence the exact pin in package.json.
 */
const persistentChromium = {
  name: () => "chromium",
  async launch() {
    return {
      async newContext() {
        return { newPage: trackedNewPage, close: async () => {} };
      },
      close: async () => {},
    };
  },
};

const renderDiagrams = createMermaidRenderer({ browserType: persistentChromium });

class DiagramError extends Error {}
class TimeoutError extends Error {}
class BodyTooLargeError extends Error {}
class OverloadedError extends Error {}
class AbortedError extends Error {}

/**
 * Launch the one browser this process will use.
 *
 * Untrusted input: the diagram source is user-controlled and is being handed
 * to a real browser, so the render page is cut off from everything it has no
 * business touching.
 *
 *   - Network: every request whose scheme is not file: is aborted at the
 *     routing layer. Mermaid diagrams can otherwise pull in remote images and
 *     icon packs, which would make each PDF export an SSRF primitive against
 *     the container's network (cloud metadata, Hydra admin, Postgres…) — the
 *     same hole infra/weasyprint/server.py closes with its URL fetcher.
 *   - Filesystem: the page's own assets (mermaid-isomorphic's blank
 *     index.html, the mermaid bundle, katex/fontawesome CSS) are file: URLs
 *     under /app/node_modules, so file: is the one scheme left open. Chromium
 *     refuses file:→file: reads from page script unless started with
 *     --allow-file-access-from-files, which we never pass, so a diagram cannot
 *     read them back out; and the container carries nothing but this service.
 *   - Execution: securityLevel "strict" keeps mermaid from injecting
 *     user-authored HTML or click handlers into the page in the first place.
 *
 * Chromium's own sandbox is off (playwright's default for launch()): enabling
 * it inside Docker needs a seccomp profile that permits user namespaces. Set
 * CHROMIUM_SANDBOX=1 and give the container playwright's seccomp profile to
 * turn it back on. The container itself is the boundary in the meantime — it
 * runs as a non-root user, serves loopback only, and has no credentials.
 */
async function startBrowser() {
  browser = await chromium.launch({
    chromiumSandbox: process.env.CHROMIUM_SANDBOX === "1",
    // Containers get a 64MB /dev/shm by default, which crashes Chromium's
    // renderer on larger diagrams.
    args: ["--disable-dev-shm-usage"],
  });

  // bypassCSP mirrors what mermaid-isomorphic asks for itself — it injects the
  // mermaid bundle into the page with addScriptTag.
  sharedContext = await browser.newContext({ bypassCSP: true });
  sharedContext.setDefaultTimeout(RENDER_TIMEOUT_MS);
  await sharedContext.route(
    (url) => url.protocol !== "file:",
    (route) => route.abort("blockedbyclient"),
  );

  // A crashed browser leaves the service permanently unable to render. Exit
  // and let the restart policy give us a fresh one.
  browser.on("disconnected", () => {
    if (shuttingDown) return;
    console.error("chromium disconnected — exiting for restart");
    process.exit(1);
  });
}

// How long a killed render gets to actually die before we give up on the
// browser entirely.
const KILL_GRACE_MS = 5000;

// Render slots. Serialising renders process-wide would be simpler, but the
// sidecar is one shared instance and every caller brings its own deadline: a
// queue behind a single slot turns an ordinary four-diagram export into two
// diagrams that time out with nothing wrong with them, and lets one slow
// diagram push every other user's export past its deadline too. So: a small
// pool, a bounded queue, and a 503 once that queue is full.
let activeRenders = 0;
const renderQueue = [];

/**
 * Wait for a render slot, then run `fn` in it.
 *
 * `signal` fires when the caller has given up. A render that hasn't started
 * yet is simply dropped from the queue — holding a slot open for a response
 * nobody will read is exactly how the queue behind it misses its own
 * deadlines. One already in flight is cancelled in withDeadline() instead, by
 * closing its page.
 */
function acquireSlot(signal) {
  if (signal.aborted) return Promise.reject(new AbortedError("Client disconnected"));

  if (activeRenders < MAX_CONCURRENT_RENDERS) {
    activeRenders += 1;
    return Promise.resolve();
  }
  if (renderQueue.length >= MAX_QUEUED_RENDERS) {
    return Promise.reject(new OverloadedError("Renderer busy — too many diagrams queued"));
  }

  return new Promise((resolve, reject) => {
    const start = () => {
      signal.removeEventListener("abort", onAbort);
      activeRenders += 1;
      resolve();
    };
    const onAbort = () => {
      const queued = renderQueue.indexOf(start);
      if (queued !== -1) renderQueue.splice(queued, 1);
      reject(new AbortedError("Client disconnected"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    renderQueue.push(start);
  });
}

async function withRenderSlot(signal, fn) {
  await acquireSlot(signal);
  try {
    return await fn();
  } finally {
    activeRenders -= 1;
    renderQueue.shift()?.();
  }
}

/**
 * Enforce the per-request deadline, and stop early if the caller has left.
 *
 * page.evaluate() has no timeout, so an expensive or cyclic diagram would
 * otherwise spin in the renderer forever, holding a slot and hanging the
 * requests behind it. Closing this render's pages is what actually aborts the
 * evaluate; the promise then rejects on its own and we report the timeout (or
 * the disconnect) instead of whatever "target closed" wording playwright
 * produced. Either way we wait for it to settle before the slot is released —
 * the render is only really over once its page is gone.
 */
async function withDeadline(promise, pages, signal) {
  let outcome;
  let graceTimer;

  const closePages = () => {
    for (const page of pages) {
      page.close().catch(() => {});
    }
  };

  const deadline = setTimeout(() => {
    outcome ??= "timeout";
    console.error(`render exceeded ${RENDER_TIMEOUT_MS}ms — closing page`);
    closePages();
    // If closing the page doesn't unstick it, the shared context is wedged and
    // every later request would queue behind a render that never ends. Bail
    // out and let the restart policy hand us a clean browser.
    graceTimer = setTimeout(() => {
      console.error("render did not abort after close — exiting for restart");
      process.exit(1);
    }, KILL_GRACE_MS);
  }, RENDER_TIMEOUT_MS);

  const onAbort = () => {
    outcome ??= "aborted";
    closePages();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    // If it beat the page close and produced an SVG anyway, take it.
    return await promise;
  } catch (e) {
    if (outcome === "timeout") throw new TimeoutError(`Diagram render exceeded ${RENDER_TIMEOUT_MS}ms`);
    if (outcome === "aborted") throw new AbortedError("Client disconnected");
    throw e;
  } finally {
    clearTimeout(deadline);
    clearTimeout(graceTimer);
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * The keys a diagram is not allowed to set for itself.
 *
 * The config handed to mermaid.initialize() is not the last word: mermaid
 * layers YAML frontmatter and %%{init}%% directives from the diagram source on
 * top of it, and the diagram source here is user-authored. `secure` is
 * mermaid's own list of keys those overrides may not touch, so htmlLabels has
 * to join it — otherwise three lines of frontmatter turn <foreignObject>
 * labels back on and the floor below is decoration. Setting `secure` unions
 * with mermaid's built-in list rather than replacing it, but the built-ins are
 * restated so this reads as the whole list it is.
 */
const SECURE_CONFIG_KEYS = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "suppressErrorRendering",
  "maxEdges",
  "htmlLabels",
];

function mermaidConfig(requested) {
  const config = { ...DEFAULT_MERMAID_CONFIG, ...(requested || {}) };
  // Re-applied after the merge, not merely defaulted: everything this service
  // renders is bound for WeasyPrint, and <foreignObject> labels would come out
  // blank there whatever the caller asked for.
  config.htmlLabels = false;
  config.flowchart = { ...config.flowchart, htmlLabels: false };
  config.secure = SECURE_CONFIG_KEYS;
  return config;
}

/**
 * Render one diagram to an SVG string.
 * Throws DiagramError when the diagram itself is at fault (bad syntax,
 * unknown diagram type) — everything else is ours.
 */
async function renderDiagram(code, config, signal) {
  const pages = new Set();

  const [result] = await withRenderSlot(signal, () =>
    renderPages.run(pages, () =>
      withDeadline(
        renderDiagrams([code], {
          mermaidConfig: mermaidConfig(config),
          // A fresh id prefix per request. mermaid scopes the <style> block it
          // emits to the diagram's root id and refers to its markers, filters
          // and classDefs by id — with the library's default "mermaid-0" for
          // every render, two diagrams inlined into one PDF restyle each other
          // and the later one's arrowheads resolve to the earlier one's defs.
          prefix: `mermaid-${randomUUID()}`,
        }),
        pages,
        signal,
      ),
    ),
  );

  if (result.status === "rejected") {
    const reason = result.reason;
    throw new DiagramError(reason?.message || String(reason));
  }

  const { svg } = result.value;
  // Belt and braces for the config floor: an SVG that still carries
  // <foreignObject> would reach the reader as a diagram with every label
  // blank. Failing is the better end — the caller falls back to the diagram's
  // source text, which at least reads.
  if (/<foreignObject[\s/>]/i.test(svg)) {
    throw new DiagramError("Diagram uses html labels, which cannot be rendered in a PDF");
  }

  return svg;
}

function sendJson(res, status, body) {
  // A caller that disconnected mid-render has nothing left to receive this.
  if (res.writableEnded || res.destroyed) return;

  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Buffer the request body, capped.
 *
 * Once the cap is hit we stop buffering but keep draining the stream rather
 * than destroying the socket: destroying it mid-upload resets the connection
 * and the caller sees a transport error instead of the { error } shape it
 * knows how to report.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    // Set as soon as the cap is passed: from then on the body is discarded as
    // it arrives, so memory stays bounded no matter what is being uploaded.
    let over = Number(req.headers["content-length"]) > MAX_BODY_BYTES;

    req.on("data", (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (over) {
        reject(new BodyTooLargeError("Request body too large"));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/**
 * POST /render — { "code": "...", "config": { ... } } -> { "svg": "..." }
 *
 * A diagram that cannot be rendered comes back as { "error": "..." } with the
 * mermaid parse message and no stack: the caller turns that into a visible
 * note under the diagram, and the surrounding document still renders. So does
 * a 503 when the queue is full — a caller that hears "busy" now degrades one
 * diagram immediately instead of waiting out its whole deadline first.
 */
async function handleRender(req, res) {
  // The caller has its own deadline and drops the connection when it passes.
  // Nothing downstream notices that by itself, so without this a give-up keeps
  // a render slot and a browser page busy producing an SVG nobody will read —
  // at the expense of the requests queued behind it. `writableFinished` is what
  // separates "the client left" from the close that follows our own response.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    sendJson(res, e instanceof BodyTooLargeError ? 413 : 400, { error: e.message });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const code = payload?.code;
  if (typeof code !== "string" || !code.trim()) {
    sendJson(res, 400, { error: "No diagram code provided" });
    return;
  }
  if (code.length > MAX_CODE_LENGTH) {
    sendJson(res, 413, { error: `Diagram exceeds ${MAX_CODE_LENGTH} characters` });
    return;
  }

  try {
    const svg = await renderDiagram(code, payload.config, abort.signal);
    sendJson(res, 200, { svg });
  } catch (e) {
    if (e instanceof AbortedError) {
      // The socket is already gone; there is nobody to tell.
      return;
    } else if (e instanceof OverloadedError) {
      sendJson(res, 503, { error: e.message });
    } else if (e instanceof DiagramError) {
      sendJson(res, 422, { error: e.message });
    } else if (e instanceof TimeoutError) {
      console.error(`render timed out after ${RENDER_TIMEOUT_MS}ms`);
      sendJson(res, 504, { error: e.message });
    } else {
      console.error("render failed:", e);
      sendJson(res, 500, { error: e?.message || "Render failed" });
    }
  }
}

const server = createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];

  if (req.method === "GET" && path === "/health") {
    // Unhealthy means "browser is gone" — the process is up but useless.
    const ok = Boolean(browser?.isConnected());
    sendJson(res, ok ? 200 : 503, { status: ok ? "ok" : "unavailable" });
    return;
  }

  if (req.method === "POST" && path === "/render") {
    handleRender(req, res).catch((e) => {
      console.error("unhandled render error:", e);
      sendJson(res, 500, { error: "Internal error" });
    });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — shutting down`);
  server.close();
  await browser?.close().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// One browser for the life of the process, started before we accept traffic so
// the first PDF export doesn't pay for the cold start.
startBrowser().then(
  () => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`mermaid renderer listening on ${PORT}`);
    });
  },
  (e) => {
    console.error("failed to launch chromium:", e);
    process.exit(1);
  },
);
