/**
 * Typst diagram renderer (see issue #117).
 * Accepts diagram source via POST, returns an SVG string.
 *
 * Why a sidecar, when the compiler is a Node addon that could load straight
 * into the API: a compile is one synchronous native call, and Typst source is
 * a programming language. `for i in range(400000000) {}` runs unbounded (Typst
 * only caps `while`), and a string doubled forty times grew a process to 1.5GB
 * in ten seconds — with the event loop frozen the whole time. In the API that
 * is every other request stalled, then the host OOM. So compiles run in child
 * processes that can be killed: a deadline and a memory ceiling per render,
 * and a fresh worker in place of any we kill.
 *
 * The workers' environment is the sandbox:
 *
 *   - Network: HTTP(S)_PROXY points at a closed port. Typst's only outbound
 *     request is a package download, and it honours the proxy, so an import
 *     of anything not vendored fails instead of fetching.
 *   - Packages: HOME / XDG_CACHE_HOME point at ./vendor, which holds exactly
 *     the pinned packages in packages.json (fetch-packages.mjs).
 *   - Filesystem: the compiler's workspace is an empty temporary directory,
 *     and Typst roots every path at the workspace, so `read("/etc/passwd")`
 *     looks inside it and finds nothing. Assets arrive in memory.
 *
 * In compose the container is also memory-limited, as a backstop for the
 * per-worker ceiling below.
 */

import { fork, execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 5003);
const POOL_SIZE = Number(process.env.POOL_SIZE || 2);
// A diagram slower than this is broken or hostile, not busy: a warm compile
// takes milliseconds, a cold one a few hundred.
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS || 8000);
const MAX_RSS_MB = Number(process.env.MAX_RSS_MB || 512);
const MAX_QUEUED = Number(process.env.MAX_QUEUED || 8);

// Bounds on what a single request may cost before any compile starts.
const MAX_SOURCE_LENGTH = 100_000;
const MAX_ASSETS = 50;
const MAX_BODY_BYTES = 8 * 1024 * 1024; // assets arrive base64-encoded
const MAX_SVG_BYTES = 8 * 1024 * 1024;

const VENDOR = process.env.TYPST_VENDOR_DIR || join(here, "vendor");
const WORKSPACE = mkdtempSync(join(tmpdir(), "typst-ws-"));
const DEAD_PROXY = "http://127.0.0.1:9";

// Default fonts. In the image these are installed under /usr/share/fonts and
// TYPST_FONT_PATHS says so; run outside it, `npm install` fetches the same
// pinned files into vendor/fonts (see package.json). The compiler also loads
// the host's system fonts whatever we pass — which is why brand fonts live
// elsewhere (see worker.mjs).
function defaultFontPaths() {
  const vendored = join(VENDOR, "fonts");
  return existsSync(vendored) ? [vendored] : [];
}

// Brand fonts, one directory per client. Outside the image, the repo's own
// mirror (scripts/sync-brand-assets.sh) if it has been populated.
const BRAND_FONT_DIR = process.env.TYPST_BRAND_FONT_DIR || join(here, "..", "fonts", "brand");

/**
 * The whole environment a worker sees. Built from scratch rather than copied
 * from ours, so nothing (credentials, a real proxy, a host Typst install's
 * package path) leaks through by accident.
 */
function sandboxEnv() {
  return {
    PATH: process.env.PATH,
    NODE_ENV: process.env.NODE_ENV || "production",
    HOME: join(VENDOR, "home"),
    XDG_CACHE_HOME: join(VENDOR, "cache"),
    XDG_DATA_HOME: join(VENDOR, "data"),
    HTTP_PROXY: DEAD_PROXY,
    HTTPS_PROXY: DEAD_PROXY,
    ALL_PROXY: DEAD_PROXY,
    http_proxy: DEAD_PROXY,
    https_proxy: DEAD_PROXY,
    all_proxy: DEAD_PROXY,
    NO_PROXY: "",
    no_proxy: "",
    TYPST_WORKSPACE: WORKSPACE,
    TYPST_FONT_PATHS: (process.env.TYPST_FONT_PATHS || defaultFontPaths().join(delimiter)),
    TYPST_BRAND_FONT_DIR: BRAND_FONT_DIR,
  };
}

class DiagramError extends Error {
  constructor(message, diagnostics) {
    super(message);
    this.diagnostics = diagnostics;
  }
}
class TimeoutError extends Error {}
class MemoryError extends Error {}
class OverloadedError extends Error {}
class BodyTooLargeError extends Error {}
class BadRequestError extends Error {}

/** Resident set size of `pid` in MB, or undefined if it can't be read. */
async function rssMb(pid) {
  if (process.platform === "linux") {
    try {
      const pages = Number(readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")[1]);
      return (pages * 4096) / 1024 / 1024;
    } catch {
      return undefined;
    }
  }
  // Elsewhere (a developer's Mac) ask ps. Slower, but only polled while busy.
  return new Promise((resolve) => {
    execFile("ps", ["-o", "rss=", "-p", String(pid)], (err, out) => {
      resolve(err ? undefined : Number(out.trim()) / 1024);
    });
  });
}

let nextJobId = 1;
let shuttingDown = false;

/**
 * One child process and the job it is running. A worker that times out, blows
 * its memory ceiling or dies is replaced, never reused: whatever state it was
 * in is not worth reasoning about.
 */
class Worker {
  constructor(pool) {
    this.pool = pool;
    this.ready = false;
    this.job = undefined;
    this.child = fork(join(here, "worker.mjs"), [], {
      env: sandboxEnv(),
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    this.child.on("message", (msg) => this.onMessage(msg));
    this.child.on("exit", (code, signal) => this.onExit(code, signal));
  }

  onMessage(msg) {
    if (msg?.type === "ready") {
      this.ready = true;
      this.pool.workerFree(this);
      return;
    }
    const job = this.job;
    if (!job || msg.id !== job.id) return;
    this.finish();
    if (msg.ok) job.resolve(msg);
    else job.reject(new DiagramError(msg.error, msg.diagnostics));
    this.pool.workerFree(this);
  }

  onExit(code, signal) {
    const job = this.job;
    this.finish();
    this.ready = false;
    if (job) job.reject(job.killedFor ?? new Error(`Render worker exited (${signal || code})`));
    this.pool.replace(this);
  }

  run(job) {
    this.job = job;
    job.timer = setTimeout(() => this.kill(new TimeoutError(`Diagram render exceeded ${RENDER_TIMEOUT_MS}ms`)), RENDER_TIMEOUT_MS);
    // The compile is synchronous inside the child, so the child can't report
    // its own size: watch it from here.
    job.watch = setInterval(async () => {
      const mb = await rssMb(this.child.pid);
      if (mb !== undefined && mb > MAX_RSS_MB && this.job === job) {
        this.kill(new MemoryError(`Diagram render exceeded ${MAX_RSS_MB}MB of memory`));
      }
    }, 100);
    this.child.send({ id: job.id, source: job.source, assets: job.assets, fontSets: job.fontSets, inputs: job.inputs });
  }

  kill(reason) {
    if (!this.job || this.job.killedFor) return;
    this.job.killedFor = reason;
    console.error(`killing render worker ${this.child.pid}: ${reason.message}`);
    this.child.kill("SIGKILL");
  }

  finish() {
    if (!this.job) return;
    clearTimeout(this.job.timer);
    clearInterval(this.job.watch);
    this.job = undefined;
  }
}

/**
 * A fixed set of workers and a bounded queue in front of them. Like the
 * mermaid sidecar, a full queue answers 503 straight away: the caller has its
 * own deadline and degrades the diagram sooner rather than later.
 */
class Pool {
  constructor(size) {
    this.workers = new Set();
    this.idle = [];
    this.queue = [];
    this.recentDeaths = [];
    for (let i = 0; i < size; i++) this.workers.add(new Worker(this));
  }

  render({ source, assets, fontSets, inputs }) {
    return new Promise((resolve, reject) => {
      const job = { id: nextJobId++, source, assets, fontSets, inputs, resolve, reject };
      const worker = this.idle.shift();
      if (worker) return worker.run(job);
      if (this.queue.length >= MAX_QUEUED) return reject(new OverloadedError("Renderer busy — too many diagrams queued"));
      this.queue.push(job);
    });
  }

  workerFree(worker) {
    const next = this.queue.shift();
    if (next) worker.run(next);
    else this.idle.push(worker);
  }

  replace(worker) {
    this.workers.delete(worker);
    this.idle = this.idle.filter((w) => w !== worker);
    if (shuttingDown) return;
    // A worker that can't even start (missing addon, unreadable prelude) would
    // otherwise respawn in a tight loop. Leave it to the restart policy.
    const now = Date.now();
    this.recentDeaths = this.recentDeaths.filter((t) => now - t < 10_000);
    this.recentDeaths.push(now);
    if (this.recentDeaths.length > POOL_SIZE * 10) {
      console.error("render workers are dying faster than they can start — exiting for restart");
      process.exit(1);
    }
    this.workers.add(new Worker(this));
  }

  get healthy() {
    return [...this.workers].some((w) => w.ready);
  }

  stop() {
    for (const w of this.workers) w.child.kill("SIGKILL");
  }
}

const pool = new Pool(POOL_SIZE);

function sendJson(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Buffer the request body, capped. Same shape as the mermaid sidecar's. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
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
      if (over) reject(new BodyTooLargeError("Request body too large"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

// An asset is addressed the way the diagram will name it, relative to
// /assets/ in the workspace: segments of [A-Za-z0-9._-], no `..`.
const FONT_SET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_FONT_SETS = 4;
const INPUT_KEYS = new Set(["font-body", "font-display", "font-mono"]);

const ASSET_PATH_RE = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

function validate(payload) {
  const source = payload?.source;
  if (typeof source !== "string" || !source.trim()) throw new BadRequestError("No diagram source provided");
  if (source.length > MAX_SOURCE_LENGTH) throw new BodyTooLargeError(`Diagram exceeds ${MAX_SOURCE_LENGTH} characters`);

  const assets = payload.assets ?? [];
  if (!Array.isArray(assets) || assets.length > MAX_ASSETS) throw new BadRequestError(`At most ${MAX_ASSETS} assets per diagram`);
  for (const asset of assets) {
    if (typeof asset?.path !== "string" || !ASSET_PATH_RE.test(asset.path)) throw new BadRequestError(`Invalid asset path: ${asset?.path}`);
    if (typeof asset.data !== "string") throw new BadRequestError(`Asset ${asset.path} has no data`);
  }
  // Brand font directories to make available, as derived by the API from the
  // space's theme. Named, never pathed, and they must exist.
  const fontSets = payload.fontSets ?? [];
  if (!Array.isArray(fontSets) || fontSets.length > MAX_FONT_SETS) throw new BadRequestError(`At most ${MAX_FONT_SETS} font sets`);
  for (const set of fontSets) {
    if (typeof set !== "string" || !FONT_SET_RE.test(set)) throw new BadRequestError(`Invalid font set: ${set}`);
    if (!existsSync(join(BRAND_FONT_DIR, set))) throw new BadRequestError(`Unknown font set: ${set}`);
  }

  // The theme's font names, read by the prelude from sys.inputs. Only the
  // keys it knows, and plain one-line names.
  const inputs = payload.inputs ?? {};
  if (typeof inputs !== "object" || Array.isArray(inputs)) throw new BadRequestError("Invalid inputs");
  for (const [key, value] of Object.entries(inputs)) {
    if (!INPUT_KEYS.has(key)) throw new BadRequestError(`Unknown input: ${key}`);
    if (typeof value !== "string" || value.length > 100 || /[\r\n]/.test(value)) throw new BadRequestError(`Invalid value for ${key}`);
  }

  return { source, assets, fontSets: [...fontSets].sort(), inputs };
}

/**
 * POST /render — { source, assets?, fontSets?, inputs? } -> { svg, width, height, warnings }
 *
 *   assets    [{ path, data }] — files the diagram can read under /assets/,
 *             data base64-encoded
 *   fontSets  brand font directories (by client name) the diagram may use
 *   inputs    { "font-body", "font-display", "font-mono" } — the theme's
 *             families, which the prelude makes the diagram's defaults
 *
 * A diagram that doesn't compile comes back 422 as { error, diagnostics },
 * each diagnostic carrying the author's line and column where the compiler
 * gave one: the caller shows them under the diagram's source, and an
 * authoring model can act on them.
 */
async function handleRender(req, res) {
  let job;
  try {
    job = validate(JSON.parse(await readBody(req)));
  } catch (e) {
    if (e instanceof BodyTooLargeError) return sendJson(res, 413, { error: e.message });
    if (e instanceof BadRequestError) return sendJson(res, 400, { error: e.message });
    return sendJson(res, 400, { error: "Invalid JSON body" });
  }

  try {
    const { svg, width, height, warnings } = await pool.render(job);
    if (Buffer.byteLength(svg) > MAX_SVG_BYTES) {
      return sendJson(res, 422, { error: `Rendered diagram exceeds ${MAX_SVG_BYTES} bytes`, diagnostics: [] });
    }
    sendJson(res, 200, { svg, width, height, warnings });
  } catch (e) {
    if (e instanceof DiagramError) sendJson(res, 422, { error: e.message, diagnostics: e.diagnostics });
    else if (e instanceof OverloadedError) sendJson(res, 503, { error: e.message });
    else if (e instanceof TimeoutError) sendJson(res, 504, { error: e.message });
    else if (e instanceof MemoryError) sendJson(res, 422, { error: e.message, diagnostics: [] });
    else {
      console.error("render failed:", e);
      sendJson(res, 500, { error: e?.message || "Render failed" });
    }
  }
}

const server = createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];

  if (req.method === "GET" && path === "/health") {
    const ok = pool.healthy;
    return sendJson(res, ok ? 200 : 503, { status: ok ? "ok" : "starting" });
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

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — shutting down`);
  pool.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`typst renderer listening on ${server.address().port}`);
});
