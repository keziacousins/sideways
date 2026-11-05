/**
 * The diagrams in the user docs (user-docs/*.md) must compile, warning-free,
 * against the real sidecar — so the guide an author or agent learns from can't
 * drift from what the renderer does.
 *
 *   - Every ```typst block is drawn by Sideways when the docs are read in a
 *     Sideways space, so every one must compile.
 *   - Every ```typ block is a source listing. It must compile too, unless its
 *     first line is `// fragment` (a snippet, not a diagram) or `// broken`
 *     (a deliberate mistake, shown in the gotchas).
 *   - A listing followed directly by a ```typst block is an example shown
 *     twice, as source and drawn: the two must be identical.
 *
 * Images a diagram names are read from beside the document, as the API would
 * hand them to the sidecar.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./helpers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DOCS = join(here, "..", "..", "..", "user-docs");

let sidecar;
before(async () => {
  sidecar = await startServer();
});
after(() => sidecar?.stop());

/** Fenced blocks in a markdown file: language, source, line number. */
function fences(markdown) {
  const out = [];
  const re = /^```(\w+)[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;
  for (const match of markdown.matchAll(re)) {
    out.push({ lang: match[1], source: match[2], line: markdown.slice(0, match.index).split("\n").length });
  }
  return out;
}

/** The images a diagram names, read from beside the document. */
function assetsFor(source) {
  const assets = [];
  for (const [, path] of source.matchAll(/"([^"\n]+\.(?:png|jpe?g|gif|webp|svg))"/gi)) {
    const file = normalize(join(DOCS, path));
    if (file.startsWith(DOCS) && existsSync(file)) {
      assets.push({ path: normalize(path), data: readFileSync(file).toString("base64") });
    }
  }
  return assets;
}

const docs = readdirSync(DOCS).filter((f) => f.endsWith(".md"));

for (const doc of docs) {
  const blocks = fences(readFileSync(join(DOCS, doc), "utf8"));

  blocks.forEach((block, i) => {
    if (block.lang !== "typst" && block.lang !== "typ") return;
    const marker = block.source.split("\n")[0].trim();
    if (block.lang === "typ" && (marker === "// fragment" || marker.startsWith("// broken"))) return;

    test(`${doc}:${block.line} ${block.lang} block compiles without warnings`, async () => {
      const { status, body } = await sidecar.render({ source: block.source, assets: assetsFor(block.source) });
      assert.equal(status, 200, `${body.error}\n${JSON.stringify(body.diagnostics)}`);
      assert.deepEqual(body.warnings, [], JSON.stringify(body.warnings));
    });

    const next = blocks[i + 1];
    if (block.lang === "typ" && next?.lang === "typst") {
      test(`${doc}:${block.line} listing matches the diagram drawn after it`, () => {
        assert.equal(block.source, next.source);
      });
    }
  });
}
