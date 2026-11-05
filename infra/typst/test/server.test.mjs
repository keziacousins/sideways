/**
 * End-to-end tests for the sidecar: a real server, real workers, real Typst.
 * Run with `npm test` in infra/typst (after `npm install`, which vendors the
 * packages). Needs no Docker and no network beyond that install.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { startServer } from "./helpers.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let sidecar;

before(async () => {
  // A brand font directory holding one client, "client-a", whose only font is
  // a family no default set has (see the `test` entry in fonts.lock).
  const brand = mkdtempSync(join(tmpdir(), "typst-brand-"));
  execFileSync("sh", [join(here, "..", "..", "fonts", "fetch-fonts.sh"), "test", brand]);

  // One worker, so a test that gets it killed proves the replacement works
  // for the test after it. Tight limits keep the hostile cases quick.
  sidecar = await startServer({ POOL_SIZE: "1", RENDER_TIMEOUT_MS: "3000", MAX_RSS_MB: "400", TYPST_BRAND_FONT_DIR: brand });
});

after(() => sidecar?.stop());

const render = (body) => sidecar.render(body);

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

const ICON = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>').toString("base64");

test("serves in-memory assets to the diagram, and only to that diagram", async () => {
  const withAsset = await render({ source: '#image("icons/x.svg", width: 1cm)', assets: [{ path: "icons/x.svg", data: ICON }] });
  assert.equal(withAsset.status, 200);
  assert.match(withAsset.body.svg, /<image/);

  const after = await render({ source: '#image("icons/x.svg", width: 1cm)' });
  assert.equal(after.status, 422);
});

test("resolves an image relative to the document, as markdown does", async () => {
  // The document is guides/arch.md; the image is img/logo.svg in its section.
  const { status, body } = await render({
    source: '#image("../img/logo.svg", width: 1cm)',
    mainDir: "guides",
    assets: [{ path: "img/logo.svg", data: ICON }],
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.match(body.svg, /<image/);
});

test("says which image is missing in the author's terms, not the sandbox's", async () => {
  const { status, body } = await render({ source: '#image("../img/nope.png")', mainDir: "guides" });
  assert.equal(status, 422);
  assert.match(body.error, /\/img\/nope\.png/);
  assert.doesNotMatch(body.error, /typst-ws-/);
});

test("rejects asset paths that try to leave the section, or take the prelude's place", async () => {
  for (const path of ["../main.typ", "__sideways__/prelude.typ", "a/./b.svg"]) {
    const { status } = await render({ source: BOX, assets: [{ path, data: "" }] });
    assert.equal(status, 400, path);
  }
  for (const mainDir of ["..", "__sideways__", "/abs"]) {
    const { status } = await render({ source: BOX, mainDir });
    assert.equal(status, 400, mainDir);
  }
});

const unknownFamily = (body) => (body.warnings ?? []).some((w) => /unknown font family: inter display/.test(w.message));
const BRAND_TEXT = '#set text(font: "Inter Display", fallback: false)\nHello';

test("draws in the default families without warnings", async () => {
  const { status, body } = await render({ source: "Hello *bold* `code`" });
  assert.equal(status, 200);
  assert.deepEqual(body.warnings, []);
});

test("keeps a brand font from a diagram whose request doesn't name its set", async () => {
  const { status, body } = await render({ source: BRAND_TEXT });
  assert.equal(status, 200);
  assert.ok(unknownFamily(body), JSON.stringify(body.warnings));
});

test("lets a diagram use a brand font when its font set is named", async () => {
  const { status, body } = await render({ source: BRAND_TEXT, fontSets: ["client-a"] });
  assert.equal(status, 200);
  assert.ok(!unknownFamily(body), JSON.stringify(body.warnings));
});

test("makes the theme's body font the diagram's default", async () => {
  const themed = await render({ source: "Hello", fontSets: ["client-a"], inputs: { "font-body": "Inter Display" } });
  assert.equal(themed.status, 200);
  assert.deepEqual(themed.body.warnings, []);
  // The same diagram unthemed comes out differently: the default family.
  const plain = await render({ source: "Hello" });
  assert.notEqual(themed.body.svg, plain.body.svg);
});

test("rejects font set names that try to leave the brand directory", async () => {
  for (const fontSets of [["../client-a"], ["client-a/.."], ["a/b"]]) {
    const { status } = await render({ source: "Hello", fontSets });
    assert.equal(status, 400, JSON.stringify(fontSets));
  }
});

test("draws in the default fonts when a font set isn't installed, and says so", async () => {
  const { status, body } = await render({ source: "Hello", fontSets: ["client-a", "not-installed"] });
  assert.equal(status, 200);
  assert.deepEqual(body.missingFontSets, ["not-installed"]);
  assert.match(body.warnings[0].message, /font set not installed in the renderer: not-installed/);
});

test("leaves no trace of one diagram's source for the next", async () => {
  // Two spaces share a compiler when they share a font set. Paths are
  // section-relative, so the second could name the first's main file.
  const first = await render({ source: "// SECRET-FROM-SPACE-A\nhello", mainDir: "guides" });
  assert.equal(first.status, 200);
  const second = await render({ source: '#read("/guides/__diagram__.typ")' });
  assert.equal(second.status, 422, "read the previous diagram's source");
  assert.match(second.body.error, /not found/);
});

test("rejects inputs the prelude doesn't read", async () => {
  const { status } = await render({ source: "Hello", inputs: { "font-body": "x", secret: "y" } });
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
