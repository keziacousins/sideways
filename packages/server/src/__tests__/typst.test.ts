import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Storage } from "@sideways/storage";

// A stand-in for the infra/typst sidecar: answers whatever the test queues.
type Reply = { status: number; body: unknown };
let replies: Reply[] = [];
let requests: Array<{
  source: string;
  mainDir?: string;
  assets?: Array<{ path: string; data: string }>;
  fontSets?: string[];
  inputs?: Record<string, string>;
}> = [];
let sidecar: Server;
let lib: typeof import("../lib/typst.js");

beforeAll(async () => {
  sidecar = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      const reply = replies.shift() ?? { status: 500, body: { error: "no reply queued" } };
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => sidecar.listen(0, "127.0.0.1", resolve));
  process.env.TYPST_URL = `http://127.0.0.1:${(sidecar.address() as AddressInfo).port}`;
  // env.ts reads TYPST_URL at import, so import only once it is set.
  lib = await import("../lib/typst.js");
});

afterAll(() => new Promise<void>((resolve) => sidecar.close(() => resolve())));

beforeEach(() => {
  replies = [];
  requests = [];
});

const SVG = '<svg class="typst-doc" viewBox="0 0 72 36" width="72pt" height="36pt"></svg>';
const ok = (): Reply => ({ status: 200, body: { svg: SVG, width: 72, height: 36 } });

/** In-memory Storage with just the calls the renderer makes. */
function memoryStorage() {
  const files = new Map<string, Buffer>();
  const storage = {
    async exists(path: string) {
      return files.has(path);
    },
    async upload(path: string, data: Buffer) {
      files.set(path, data);
      return { path, size: data.length };
    },
  } as unknown as Storage;
  return { storage, files };
}

describe("formatDiagnostics", () => {
  it("puts located errors first-class, with hints, and caps the list", () => {
    const text = lib.formatDiagnostics("unknown variable", [
      { message: "unknown variable: nonsense", line: 3, column: 3, hints: ["did you mean `draw.rect`?"] },
      { message: "panicked", package: "@preview/cetz:0.4.2" },
      { message: "a" },
      { message: "dropped — past the cap" },
    ]);
    expect(text).toBe(
      "line 3, column 3: unknown variable: nonsense (hint: did you mean `draw.rect`?); in @preview/cetz:0.4.2: panicked; a",
    );
  });

  it("falls back to the bare error when there are no diagnostics", () => {
    expect(lib.formatDiagnostics("boom")).toBe("boom");
  });
});

describe("createTypstRenderer — inline", () => {
  it("returns a data: URI and the size in CSS px", async () => {
    replies.push(ok());
    const { render } = lib.createTypstRenderer({ kind: "inline" });
    const diagram = await render("#canvas({})");
    expect(diagram.src).toBe(`data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}`);
    expect(diagram.width).toBeCloseTo(96);
    expect(diagram.height).toBeCloseTo(48);
    expect(requests).toEqual([{ source: "#canvas({})", mainDir: "", assets: [], fontSets: [], inputs: {} }]);
  });
});

describe("createTypstRenderer — store", () => {
  it("stores the SVG under its content address and points at it", async () => {
    replies.push(ok());
    const { storage, files } = memoryStorage();
    const { render } = lib.createTypstRenderer({ kind: "store", storage, spaceId: "space-id", spaceSlug: "my-space" });

    const diagram = await render("#canvas({})");
    const key = lib.diagramKey("#canvas({})");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(diagram.src).toBe(`/d/my-space/${key}.svg`);
    expect(files.get(`/diagrams/space-id/${key}.svg`)?.toString()).toBe(SVG);
  });

  it("reuses a stored diagram without asking the sidecar again", async () => {
    const { storage } = memoryStorage();
    const mode = { kind: "store" as const, storage, spaceId: "space-id", spaceSlug: "my-space" };
    replies.push(ok());
    await lib.createTypstRenderer(mode).render("#canvas({})");
    await lib.createTypstRenderer(mode).render("#canvas({})");
    expect(requests).toHaveLength(1);
  });

  it("gives different sources different addresses", () => {
    expect(lib.diagramKey("a")).not.toBe(lib.diagramKey("b"));
  });
});

describe("createTypstRenderer — failures", () => {
  it("passes on the compiler's located diagnostics, and doesn't call it transient", async () => {
    replies.push({
      status: 422,
      body: { error: "unknown variable: nonsense", diagnostics: [{ message: "unknown variable: nonsense", line: 2, column: 5 }] },
    });
    const renderer = lib.createTypstRenderer({ kind: "inline" });
    await expect(renderer.render("x")).rejects.toThrow("line 2, column 5: unknown variable: nonsense");
    expect(renderer.transientFailure).toBe(false);
  });

  it("calls a busy sidecar transient", async () => {
    replies.push({ status: 503, body: { error: "Renderer busy" } });
    const renderer = lib.createTypstRenderer({ kind: "inline" });
    await expect(renderer.render("x")).rejects.toThrow(/503/);
    expect(renderer.transientFailure).toBe(true);
  });

  it("calls a storage failure transient", async () => {
    replies.push(ok());
    const storage = {
      exists: async () => false,
      upload: async () => {
        throw new Error("SeaweedFS upload failed: 500");
      },
    } as unknown as Storage;
    const renderer = lib.createTypstRenderer({ kind: "store", storage, spaceId: "s", spaceSlug: "s" });
    await expect(renderer.render("x")).rejects.toThrow(/SeaweedFS/);
    expect(renderer.transientFailure).toBe(true);
  });

  it("caps the diagrams in one document", async () => {
    const renderer = lib.createTypstRenderer({ kind: "inline" });
    for (let i = 0; i < 50; i++) replies.push(ok());
    await Promise.all(Array.from({ length: 50 }, () => renderer.render("x")));
    await expect(renderer.render("x")).rejects.toThrow(/Too many Typst diagrams/);
    expect(renderer.transientFailure).toBe(false);
  });
});

describe("theme fonts", () => {
  const tokens = {
    fonts: {
      body: "Proxima Nova",
      display: "Proxima Nova",
      custom: [
        { family: "Proxima Nova", weight: "400", src: "/fonts/client-a/regular.otf" },
        { family: "Proxima Nova", weight: "700", src: "/fonts/client-a/bold.otf" },
        { family: "Other", src: "/fonts/client-b/other.otf" },
        { family: "Remote", src: "https://example.com/font.woff2" },
      ],
    },
  };

  it("derives the brand font sets and default families from the tokens", () => {
    expect(lib.typstFontContext(tokens)).toEqual({
      fontSets: ["client-a", "client-b"],
      inputs: { "font-body": "Proxima Nova", "font-display": "Proxima Nova" },
    });
  });

  it("ignores names that aren't plain font names, and themes without fonts", () => {
    expect(lib.typstFontContext({ fonts: { body: 'X", "Y' } })).toEqual(lib.NO_THEME_FONTS);
    expect(lib.typstFontContext({ fonts: { custom: [{ src: "/fonts/../etc/x.otf" }] } })).toEqual(lib.NO_THEME_FONTS);
    expect(lib.typstFontContext(null)).toEqual(lib.NO_THEME_FONTS);
    expect(lib.typstFontContext({})).toEqual(lib.NO_THEME_FONTS);
  });

  it("sends the context with the render, and keys stored diagrams by it", async () => {
    const fonts = lib.typstFontContext(tokens);
    replies.push(ok());
    await lib.createTypstRenderer({ kind: "inline" }, fonts).render("x");
    expect(requests[0]).toMatchObject({ source: "x", fontSets: fonts.fontSets, inputs: fonts.inputs });
    expect(lib.diagramKey("x", fonts)).not.toBe(lib.diagramKey("x"));
  });

  it("collects the compiler's warnings for the author", async () => {
    replies.push({ status: 200, body: { svg: SVG, warnings: [{ message: "unknown font family: nope", line: 1, column: 1 }] } });
    const renderer = lib.createTypstRenderer({ kind: "inline" });
    await renderer.render("x");
    expect(renderer.warnings).toEqual(["line 1, column 1: unknown font family: nope"]);
  });
});

describe("diagram assets", () => {
  const LOGO = Buffer.from("png bytes");
  const doc = (files: Record<string, { hash: string; bytes: Buffer }>) => {
    const loads: string[] = [];
    return {
      loads,
      doc: {
        docPath: "guides/arch.md",
        async findAsset(path: string) {
          const file = files[path];
          if (!file) return null;
          return { contentHash: file.hash, load: async () => (loads.push(path), file.bytes) };
        },
      },
    };
  };

  it("sends the files the diagram reads, from the document's directory", async () => {
    replies.push(ok());
    const { doc: d } = doc({ "img/logo.png": { hash: "h1", bytes: LOGO } });
    await lib.createTypstRenderer({ kind: "inline" }, lib.NO_THEME_FONTS, d).render('#image("../img/logo.png")');
    expect(requests[0].mainDir).toBe("guides");
    expect(requests[0].assets).toEqual([{ path: "img/logo.png", data: LOGO.toString("base64") }]);
  });

  it("leaves a missing file for Typst to report", async () => {
    replies.push(ok());
    const { doc: d } = doc({});
    await lib.createTypstRenderer({ kind: "inline" }, lib.NO_THEME_FONTS, d).render('#image("../img/nope.png")');
    expect(requests[0].assets).toEqual([]);
  });

  it("keys a stored diagram by the content of the files it reads, and doesn't load them when it's stored", async () => {
    const { storage, files } = memoryStorage();
    const mode = { kind: "store" as const, storage, spaceId: "s", spaceSlug: "s" };
    const source = '#image("../img/logo.png")';

    replies.push(ok());
    const v1 = doc({ "img/logo.png": { hash: "h1", bytes: LOGO } });
    const first = await lib.createTypstRenderer(mode, lib.NO_THEME_FONTS, v1.doc).render(source);

    const again = doc({ "img/logo.png": { hash: "h1", bytes: LOGO } });
    const second = await lib.createTypstRenderer(mode, lib.NO_THEME_FONTS, again.doc).render(source);
    expect(second.src).toBe(first.src);
    expect(again.loads).toEqual([]);

    replies.push(ok());
    const v2 = doc({ "img/logo.png": { hash: "h2", bytes: LOGO } });
    const replaced = await lib.createTypstRenderer(mode, lib.NO_THEME_FONTS, v2.doc).render(source);
    expect(replaced.src).not.toBe(first.src);
    expect(files.size).toBe(2);
  });

  it("refuses a diagram whose images are too big, as the diagram's fault", async () => {
    const { doc: d } = doc({ "img/huge.png": { hash: "h", bytes: Buffer.alloc(6 * 1024 * 1024) } });
    const renderer = lib.createTypstRenderer({ kind: "inline" }, lib.NO_THEME_FONTS, d);
    await expect(renderer.render('#image("../img/huge.png")')).rejects.toThrow(/at most 5MB/);
    expect(renderer.transientFailure).toBe(false);
    expect(requests).toEqual([]);
  });
});

describe("review follow-ups", () => {
  it("caches a diagram the sidecar killed at its deadline, as the diagram's fault", async () => {
    replies.push({ status: 504, body: { error: "Diagram render exceeded 8000ms" } });
    const renderer = lib.createTypstRenderer({ kind: "inline" });
    await expect(renderer.render("x")).rejects.toThrow(/exceeded 8000ms/);
    expect(renderer.transientFailure).toBe(false);
    expect(renderer.cacheable).toBe(true);
  });

  it("treats the sidecar refusing a request as the diagram's fault", async () => {
    replies.push({ status: 400, body: { error: "At most 50 assets per diagram" } });
    const renderer = lib.createTypstRenderer({ kind: "inline" });
    await expect(renderer.render("x")).rejects.toThrow(/At most 50 assets/);
    expect(renderer.cacheable).toBe(true);
  });

  it("shows a diagram drawn without missing brand fonts, but neither stores it nor lets the page be cached", async () => {
    replies.push({ status: 200, body: { svg: SVG, missingFontSets: ["client-a"], warnings: [{ message: "font set not installed" }] } });
    const { storage, files } = memoryStorage();
    const renderer = lib.createTypstRenderer({ kind: "store", storage, spaceId: "s", spaceSlug: "s" });
    const diagram = await renderer.render("x");
    expect(diagram.src).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(files.size).toBe(0);
    expect(renderer.cacheable).toBe(false);
  });

  it("gives stored diagrams no dimensions, fresh or reused, so the HTML doesn't depend on render order", async () => {
    const { storage } = memoryStorage();
    const mode = { kind: "store" as const, storage, spaceId: "s", spaceSlug: "s" };
    replies.push(ok());
    const fresh = await lib.createTypstRenderer(mode).render("x");
    const reused = await lib.createTypstRenderer(mode).render("x");
    expect(fresh).toEqual(reused);
    expect(fresh.width).toBeUndefined();
  });

  it("reads an image once per document render, however many diagrams show it", async () => {
    let loads = 0;
    const doc = {
      docPath: "doc.md",
      findAsset: async () => ({ contentHash: "h", load: async () => (loads++, Buffer.from("logo")) }),
    };
    const renderer = lib.createTypstRenderer({ kind: "inline" }, lib.NO_THEME_FONTS, doc);
    replies.push(ok(), ok(), ok());
    await Promise.all(['#image("logo.png") 1', '#image("logo.png") 2', '#image("logo.png") 3'].map((d) => renderer.render(d)));
    expect(loads).toBe(1);
    expect(requests.every((r) => r.assets?.length === 1)).toBe(true);
  });

  it("digests a font context stably, and differently for different fonts", () => {
    const a = lib.typstFontContext({ fonts: { body: "Inter" } });
    expect(lib.fontContextKey(a)).toBe(lib.fontContextKey(lib.typstFontContext({ fonts: { body: "Inter" } })));
    expect(lib.fontContextKey(a)).not.toBe(lib.fontContextKey(lib.NO_THEME_FONTS));
  });
});
