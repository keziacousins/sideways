import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for the infra/typst sidecar: answers whatever the test queues.
type Reply = { status: number; body: unknown };
let replies: Reply[] = [];
let sidecar: Server;
let lib: typeof import("../lib/diagram-preview.js");
let typst: typeof import("../lib/typst.js");

beforeAll(async () => {
  sidecar = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const reply = replies.shift() ?? { status: 500, body: { error: "no reply queued" } };
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => sidecar.listen(0, "127.0.0.1", resolve));
  process.env.TYPST_URL = `http://127.0.0.1:${(sidecar.address() as AddressInfo).port}`;
  // env.ts reads TYPST_URL at import, so import only once it is set.
  lib = await import("../lib/diagram-preview.js");
  typst = await import("../lib/typst.js");
});

afterAll(() => new Promise<void>((resolve) => sidecar.close(() => resolve())));

beforeEach(() => {
  replies = [];
});

// 72pt x 36pt, as the sidecar sizes a Typst page: 96 x 48 CSS px.
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 36" width="72pt" height="36pt">' +
  '<rect x="0" y="0" width="36" height="36" fill="#147eba"/></svg>';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const doc = { docPath: "guides/arch.md", findAsset: async () => null };

describe("rasterise", () => {
  it("draws the SVG as a PNG at twice its size, on white", () => {
    const { png, width, height } = lib.rasterise(SVG);
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect([width, height]).toEqual([192, 96]);
  });

  it("caps the longest side for a very large diagram", () => {
    const big = SVG.replace('width="72pt" height="36pt"', 'width="3000pt" height="1500pt"');
    const { width, height } = lib.rasterise(big);
    expect(width).toBe(2000);
    expect(height).toBe(1000);
  });
});

describe("previewDiagram", () => {
  it("returns the PNG and the compiler's warnings", async () => {
    replies.push({
      status: 200,
      body: { svg: SVG, width: 72, height: 36, warnings: [{ message: "unknown font family: Comic", line: 2, column: 3 }] },
    });
    const preview = await lib.previewDiagram("#rect()", typst.NO_THEME_FONTS, doc);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(preview.warnings).toEqual(["line 2, column 3: unknown font family: Comic"]);
  });

  it("returns the compiler's errors for a diagram that doesn't compile", async () => {
    replies.push({
      status: 422,
      body: { error: "compile failed", diagnostics: [{ message: "unknown variable: rec", line: 1, column: 2 }] },
    });
    const preview = await lib.previewDiagram("#rec()", typst.NO_THEME_FONTS, doc);
    expect(preview).toEqual({ ok: false, error: "line 1, column 2: unknown variable: rec", warnings: [] });
  });

  it("says when the failure isn't the diagram's", async () => {
    replies.push({ status: 503, body: { error: "busy" } });
    const preview = await lib.previewDiagram("#rect()", typst.NO_THEME_FONTS, doc);
    expect(preview.ok).toBe(false);
    expect("transient" in preview && preview.transient).toBe(true);
  });
});
