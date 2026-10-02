import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyAsset,
  hashBytes,
  surveyAssets,
  planAssets,
  runAssetPlan,
} from "../assets.js";
import type { AssetInfo } from "../api.js";
import type { SyncState } from "../sync.js";

describe("classifyAsset", () => {
  it("is unchanged when both sides hold the same bytes", () => {
    expect(classifyAsset({ localHash: "a", remoteHash: "a" })).toBe("unchanged");
    expect(classifyAsset({ localHash: "a", remoteHash: "a", syncedHash: "old" })).toBe("unchanged");
  });

  it("is new on whichever side has it alone", () => {
    expect(classifyAsset({ localHash: "a", remoteHash: null })).toBe("new-local");
    expect(classifyAsset({ localHash: null, remoteHash: "a" })).toBe("new-remote");
  });

  it("re-pushes an asset the server has lost", () => {
    expect(classifyAsset({ localHash: "a", remoteHash: null, syncedHash: "a" })).toBe("new-local");
  });

  it("leaves alone an asset that was synced and then removed from disk", () => {
    expect(classifyAsset({ localHash: null, remoteHash: "a", syncedHash: "a" })).toBe("deleted-local");
  });

  it("uses the last reconciled hash to tell which side moved", () => {
    expect(classifyAsset({ localHash: "new", remoteHash: "a", syncedHash: "a" })).toBe("local-modified");
    expect(classifyAsset({ localHash: "a", remoteHash: "new", syncedHash: "a" })).toBe("remote-modified");
    expect(classifyAsset({ localHash: "mine", remoteHash: "theirs", syncedHash: "a" })).toBe("conflict");
  });

  it("falls back to modification time when nothing was ever reconciled", () => {
    expect(classifyAsset({ localHash: "a", remoteHash: "b", localMtime: 2, remoteMtime: 1 }))
      .toBe("local-modified");
    expect(classifyAsset({ localHash: "a", remoteHash: "b", localMtime: 1, remoteMtime: 2 }))
      .toBe("remote-modified");
  });
});

describe("asset sync", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** A repo root holding the given files; a string value is file content. */
  function makeRepo(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "sideways-assets-"));
    dirs.push(root);
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    return root;
  }

  const remoteAsset = (path: string, content: string, updatedAt = "2026-01-01T00:00:00Z"): AssetInfo => ({
    sectionSlug: "docs",
    path,
    mimeType: "image/png",
    size: content.length,
    contentHash: hashBytes(Buffer.from(content)),
    updatedAt,
    url: `/a/sp/docs/${path}`,
  });

  /** A stand-in for the API client, backed by an in-memory asset store. */
  function fakeClient(initial: AssetInfo[] | null, bytes: Record<string, string> = {}) {
    const uploaded: Array<{ path: string; content: string }> = [];
    return {
      uploaded,
      listAssets: async () => initial,
      putAsset: async (_space: string, sectionSlug: string, path: string, body: Uint8Array) => {
        if (path.includes(" ")) throw new Error(`Path segment "${path}" contains invalid characters`);
        const content = Buffer.from(body).toString();
        uploaded.push({ path, content });
        return { ...remoteAsset(path, content), sectionSlug };
      },
      getAsset: async (_space: string, _section: string, path: string) => Buffer.from(bytes[path]),
    } as any;
  }

  const emptyState = (): SyncState => ({ space: "sp", lastSync: "", files: {}, schema: 2 });

  function survey(
    root: string,
    client: any,
    opts: { docs: string[]; includeRemote?: boolean; syncState?: SyncState },
  ) {
    return surveyAssets({
      client,
      space: "sp",
      rootDir: root,
      mounts: [{ sectionSlug: "docs", dir: root, relDir: "" }],
      syncState: opts.syncState ?? emptyState(),
      files: opts.docs.map((path) => ({
        sectionSlug: "docs",
        path,
        absPath: join(root, path),
        relPath: path,
      })),
      includeRemote: opts.includeRemote ?? false,
    });
  }

  const statuses = (s: { candidates: Array<{ path: string; status: string }> }) =>
    Object.fromEntries(s.candidates.map((c) => [c.path, c.status]));

  it("finds the files a document references, relative to that document", async () => {
    const root = makeRepo({
      "guides/auth.md": "![flow](./img/flow.png)\n\nSee the [spec](../spec.pdf).\n",
      "guides/img/flow.png": "PNG",
      "spec.pdf": "PDF",
      "guides/img/unreferenced.png": "PNG",
    });
    const result = await survey(root, fakeClient([]), { docs: ["guides/auth.md"] });
    expect(statuses(result)).toEqual({
      "guides/img/flow.png": "new-local",
      "spec.pdf": "new-local",
    });
  });

  it("ignores references in code fences, external URLs and other documents", async () => {
    const root = makeRepo({
      "a.md": [
        "```md",
        "![not a reference](./fenced.png)",
        "```",
        "![remote](https://example.com/x.png)",
        "[other doc](./b.md)",
        "[archive](./files.zip)",
      ].join("\n"),
      "fenced.png": "PNG",
      "b.md": "# b",
      "files.zip": "ZIP",
    });
    const result = await survey(root, fakeClient([]), { docs: ["a.md"] });
    expect(result.candidates).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it("reads references past frontmatter and embedded comments", async () => {
    const root = makeRepo({
      "a.md": "---\ntitle: A\ntags: [x]\n---\n# A\n\n![flow](flow.png)\n",
      "flow.png": "PNG",
    });
    const result = await survey(root, fakeClient([]), { docs: ["a.md"] });
    expect(statuses(result)).toEqual({ "flow.png": "new-local" });
  });

  it("reports a reference to a file that is nowhere", async () => {
    const root = makeRepo({ "guides/auth.md": "![flow](./img/gone.png)" });
    const result = await survey(root, fakeClient([]), { docs: ["guides/auth.md"] });
    expect(result.candidates).toEqual([]);
    expect(result.missing).toEqual([
      { docRelPath: "guides/auth.md", relPath: "guides/img/gone.png" },
    ]);
  });

  it("counts a referenced file once however many documents use it", async () => {
    const root = makeRepo({
      "a.md": "![logo](logo.png)",
      "b.md": "![logo](./logo.png) and again ![logo](logo.png)",
      "logo.png": "PNG",
    });
    const result = await survey(root, fakeClient([]), { docs: ["a.md", "b.md"] });
    expect(result.candidates.map((c) => c.path)).toEqual(["logo.png"]);
  });

  it("compares against the server and the last reconcile", async () => {
    const root = makeRepo({
      "a.md": "![same](same.png) ![mine](mine.png) ![theirs](theirs.png) ![both](both.png)",
      "same.png": "v1",
      "mine.png": "v2-local",
      "theirs.png": "v1",
      "both.png": "v2-local",
    });
    const client = fakeClient([
      remoteAsset("same.png", "v1"),
      remoteAsset("mine.png", "v1"),
      remoteAsset("theirs.png", "v2-remote"),
      remoteAsset("both.png", "v2-remote"),
    ]);
    const v1 = hashBytes(Buffer.from("v1"));
    const syncState: SyncState = {
      ...emptyState(),
      assets: Object.fromEntries(
        ["same", "mine", "theirs", "both"].map((n) => [
          `docs:${n}.png`,
          { sectionSlug: "docs", path: `${n}.png`, hash: v1 },
        ]),
      ),
    };
    const result = await survey(root, client, { docs: ["a.md"], syncState });
    expect(statuses(result)).toEqual({
      "same.png": "unchanged",
      "mine.png": "local-modified",
      "theirs.png": "remote-modified",
      "both.png": "conflict",
    });
  });

  it("includes unreferenced remote assets only when asked to", async () => {
    const root = makeRepo({ "a.md": "# no images" });
    const client = fakeClient([remoteAsset("img/remote.png", "PNG")]);

    expect((await survey(root, client, { docs: ["a.md"] })).candidates).toEqual([]);

    const withRemote = await survey(root, client, { docs: ["a.md"], includeRemote: true });
    expect(statuses(withRemote)).toEqual({ "img/remote.png": "new-remote" });
  });

  it("skips remote assets in a section this repo doesn't own", async () => {
    const root = makeRepo({ "a.md": "# a" });
    const elsewhere = { ...remoteAsset("x.png", "PNG"), sectionSlug: "someone-elses" };
    const result = await survey(root, fakeClient([elsewhere]), { docs: [], includeRemote: true });
    expect(result.candidates).toEqual([]);
  });

  it("flags a server that predates hosted assets, and plans nothing against it", async () => {
    const root = makeRepo({ "a.md": "![x](x.png)", "x.png": "PNG" });
    const result = await survey(root, fakeClient(null), { docs: ["a.md"] });
    expect(result.supported).toBe(false);
    expect(planAssets(result, { push: true, pull: true }).uploads).toEqual([]);
  });

  it("plans by direction, and resolves conflicts only when forced", async () => {
    const root = makeRepo({
      "a.md": "![n](new.png) ![m](mine.png) ![t](theirs.png) ![b](both.png)",
      "new.png": "x",
      "mine.png": "v2-local",
      "theirs.png": "v1",
      "both.png": "v2-local",
    });
    const client = fakeClient([
      remoteAsset("mine.png", "v1"),
      remoteAsset("theirs.png", "v2-remote"),
      remoteAsset("both.png", "v2-remote"),
      remoteAsset("remote-only.png", "r"),
    ]);
    const v1 = hashBytes(Buffer.from("v1"));
    const syncState: SyncState = {
      ...emptyState(),
      assets: Object.fromEntries(
        ["mine", "theirs", "both"].map((n) => [
          `docs:${n}.png`,
          { sectionSlug: "docs", path: `${n}.png`, hash: v1 },
        ]),
      ),
    };
    const result = await survey(root, client, { docs: ["a.md"], includeRemote: true, syncState });
    const paths = (list: Array<{ path: string }>) => list.map((c) => c.path).sort();

    const push = planAssets(result, { push: true, pull: false });
    expect(paths(push.uploads)).toEqual(["mine.png", "new.png"]);
    expect(paths(push.downloads)).toEqual([]);
    expect(paths(push.conflicts)).toEqual(["both.png"]);

    const pull = planAssets(result, { push: false, pull: true });
    expect(paths(pull.uploads)).toEqual([]);
    expect(paths(pull.downloads)).toEqual(["remote-only.png", "theirs.png"]);
    expect(paths(pull.conflicts)).toEqual(["both.png"]);

    expect(paths(planAssets(result, { push: true, pull: false, force: "push" }).uploads))
      .toEqual(["both.png", "mine.png", "new.png"]);
    expect(paths(planAssets(result, { push: false, pull: true, force: "pull" }).downloads))
      .toEqual(["both.png", "remote-only.png", "theirs.png"]);
  });

  it("uploads, downloads, and records what it reconciled", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = makeRepo({
      "a.md": "![up](up.png) ![same](same.png)",
      "up.png": "local bytes",
      "same.png": "agreed",
    });
    const client = fakeClient(
      [remoteAsset("same.png", "agreed"), remoteAsset("img/down.png", "remote bytes")],
      { "img/down.png": "remote bytes" },
    );
    const syncState = emptyState();
    const result = await survey(root, client, { docs: ["a.md"], includeRemote: true, syncState });
    const outcome = await runAssetPlan(planAssets(result, { push: true, pull: true }), {
      client,
      space: "sp",
      syncState,
    });

    expect(outcome).toEqual({ pushed: 1, pulled: 1, failed: 0 });
    expect(client.uploaded).toEqual([{ path: "up.png", content: "local bytes" }]);
    expect(readFileSync(join(root, "img/down.png"), "utf-8")).toBe("remote bytes");
    expect(syncState.assets).toEqual({
      "docs:up.png": { sectionSlug: "docs", path: "up.png", hash: hashBytes(Buffer.from("local bytes")) },
      "docs:same.png": { sectionSlug: "docs", path: "same.png", hash: hashBytes(Buffer.from("agreed")) },
      "docs:img/down.png": {
        sectionSlug: "docs",
        path: "img/down.png",
        hash: hashBytes(Buffer.from("remote bytes")),
      },
    });
  });

  it("touches nothing on a dry run", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = makeRepo({ "a.md": "![up](up.png)", "up.png": "local" });
    const client = fakeClient([remoteAsset("down.png", "remote")], { "down.png": "remote" });
    const syncState = emptyState();
    const result = await survey(root, client, { docs: ["a.md"], includeRemote: true, syncState });
    const outcome = await runAssetPlan(planAssets(result, { push: true, pull: true }), {
      client,
      space: "sp",
      syncState,
      dryRun: true,
    });

    expect(outcome).toEqual({ pushed: 1, pulled: 1, failed: 0 });
    expect(client.uploaded).toEqual([]);
    expect(existsSync(join(root, "down.png"))).toBe(false);
    expect(syncState.assets).toBeUndefined();
  });

  it("reports an asset the server refuses and carries on with the rest", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const root = makeRepo({
      "a.md": "![bad](<my flow.png>) ![good](good.png)",
      "my flow.png": "PNG",
      "good.png": "PNG",
    });
    const client = fakeClient([]);
    const syncState = emptyState();
    const result = await survey(root, client, { docs: ["a.md"], syncState });
    const outcome = await runAssetPlan(planAssets(result, { push: true, pull: false }), {
      client,
      space: "sp",
      syncState,
    });

    expect(outcome).toEqual({ pushed: 1, pulled: 0, failed: 1 });
    expect(client.uploaded.map((u: { path: string }) => u.path)).toEqual(["good.png"]);
    expect(log.mock.calls.flat().join("\n")).toContain("failed: my flow.png");
    expect(Object.keys(syncState.assets ?? {})).toEqual(["docs:good.png"]);
  });
});
