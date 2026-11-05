import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Storage } from "@sideways/storage";

// A stand-in for the infra/typst sidecar: answers whatever the test queues.
type Reply = { status: number; body: unknown };
let replies: Reply[] = [];
let requests: Array<{ source: string }> = [];
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
    expect(requests).toEqual([{ source: "#canvas({})" }]);
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
