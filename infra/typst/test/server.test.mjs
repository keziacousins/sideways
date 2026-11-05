/**
 * End-to-end tests for the sidecar: a real server, real workers, real Typst.
 * Run with `npm test` in infra/typst (after `npm install`, which vendors the
 * packages). Needs no Docker and no network beyond that install.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let server;
let base;

before(async () => {
  server = spawn(process.execPath, [join(here, "..", "server.mjs")], {
    // One worker, so a test that gets it killed proves the replacement works
    // for the test after it. Tight limits keep the hostile cases quick.
    env: { ...process.env, PORT: "0", POOL_SIZE: "1", RENDER_TIMEOUT_MS: "3000", MAX_RSS_MB: "400" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  base = await new Promise((resolve, reject) => {
    server.stdout.on("data", (chunk) => {
      const match = String(chunk).match(/listening on (\d+)/);
      if (match) resolve(`http://127.0.0.1:${match[1]}`);
    });
    server.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
  // Wait for the worker to be up, not just the HTTP listener.
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${base}/health`).catch(() => undefined);
    if (res?.ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("worker never became ready");
});

after(() => server?.kill("SIGTERM"));

async function render(body) {
  const res = await fetch(`${base}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const BOX = `#canvas({ draw.rect((0, 0), (2, 1), name: "a"); draw.content("a", [Hello]) })`;

test("renders a CeTZ diagram from the vendored package, with the prelude applied", async () => {
  const { status, body } = await render({ source: BOX });
  assert.equal(status, 200);
  assert.match(body.svg, /^<svg/);
  // Text is drawn as glyph outlines, never <text>.
  assert.doesNotMatch(body.svg, /<text/);
  // The prelude shrink-wraps the page to the drawing: far smaller than A4.
  assert.ok(body.width > 0 && body.width < 200, `width ${body.width}`);
  assert.ok(body.height > 0 && body.height < 200, `height ${body.height}`);
});

test("reports compile errors with the author's line and column", async () => {
  const { status, body } = await render({ source: "#canvas({\n  draw.rect((0, 0), (1, 1))\n  draw.nonsense()\n})" });
  assert.equal(status, 422);
  const located = body.diagnostics.find((d) => d.line);
  assert.ok(located, JSON.stringify(body.diagnostics));
  assert.equal(located.line, 3);
});

test("cannot fetch a package that isn't vendored", async () => {
  const { status, body } = await render({ source: '#import "@preview/fletcher:0.5.8": diagram' });
  assert.equal(status, 422);
  assert.match(body.error, /download|package/i);
});

test("cannot read files from the host", async () => {
  const { status, body } = await render({ source: '#read("/etc/passwd")' });
  assert.equal(status, 422);
  assert.match(body.error, /not found/i);
});

test("serves in-memory assets to the diagram, and only to that diagram", async () => {
  const icon = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>').toString("base64");
  const withAsset = await render({ source: '#image("/assets/icons/x.svg", width: 1cm)', assets: [{ path: "icons/x.svg", data: icon }] });
  assert.equal(withAsset.status, 200);
  assert.match(withAsset.body.svg, /<image/);

  const after = await render({ source: '#image("/assets/icons/x.svg", width: 1cm)' });
  assert.equal(after.status, 422);
});

test("rejects asset paths that try to leave the assets directory", async () => {
  const { status } = await render({ source: BOX, assets: [{ path: "../main.typ", data: "" }] });
  assert.equal(status, 400);
});

test("kills a render that runs past the deadline, and keeps serving", async () => {
  // Nested small ranges: CPU-bound without allocating a huge array, which the
  // memory ceiling would catch first.
  const { status, body } = await render({ source: "#let n = 0\n#for i in range(30000) { for j in range(30000) { n += 1 } }" });
  assert.equal(status, 504);
  assert.match(body.error, /exceeded/);

  const next = await render({ source: BOX });
  assert.equal(next.status, 200);
});

test("kills a render that exceeds the memory ceiling, and keeps serving", async () => {
  const { status, body } = await render({ source: '#let s = "x"\n#for i in range(40) { s = s + s }\n#s.len()' });
  assert.equal(status, 422);
  assert.match(body.error, /memory/);

  const next = await render({ source: BOX });
  assert.equal(next.status, 200);
});
