import { describe, it, expect } from "vitest";
import { embedComments, extractComments, type SerializedComment } from "../comments.js";

const makeComment = (overrides: Partial<SerializedComment> = {}): SerializedComment => ({
  id: "c1",
  author: "kezia",
  date: "2026-03-26",
  body: "A comment.",
  anchorText: null,
  parentId: null,
  resolved: false,
  ...overrides,
});

describe("embedComments", () => {
  it("embeds unanchored comments at the top", () => {
    const md = "# Hello\n\nSome content.";
    const result = embedComments(md, [makeComment()]);
    expect(result).toContain('<!-- @comment id="c1"');
    expect(result.indexOf("@comment")).toBeLessThan(result.indexOf("# Hello"));
  });

  it("embeds anchored comments after the anchor text", () => {
    const md = "# Hello\n\nFirst paragraph.\n\nSecond paragraph.";
    const comment = makeComment({
      anchorText: "First paragraph.",
    });
    const result = embedComments(md, [comment]);
    const anchorIdx = result.indexOf("First paragraph.");
    const commentIdx = result.indexOf("@comment");
    expect(commentIdx).toBeGreaterThan(anchorIdx);
    expect(result.indexOf("Second paragraph.")).toBeGreaterThan(commentIdx);
  });

  it("places orphaned anchored comments at the top", () => {
    const md = "# Hello\n\nSome content.";
    const comment = makeComment({
      anchorText: "nonexistent text",
    });
    const result = embedComments(md, [comment]);
    expect(result.indexOf("@comment")).toBeLessThan(result.indexOf("# Hello"));
  });

  it("embeds threaded replies after parent", () => {
    const md = "# Hello\n\nContent here.";
    const parent = makeComment({ id: "p1", anchorText: "Content here." });
    const reply = makeComment({
      id: "r1",
      author: "claude",
      parentId: "p1",
      body: "Reply to parent.",
    });
    const result = embedComments(md, [parent, reply]);
    const parentIdx = result.indexOf('id="p1"');
    const replyIdx = result.indexOf('id="r1"');
    expect(replyIdx).toBeGreaterThan(parentIdx);
  });

  it("includes resolved flag", () => {
    const comment = makeComment({ resolved: true });
    const result = embedComments("# Test", [comment]);
    expect(result).toContain(" resolved");
  });

  it("returns unchanged markdown with no comments", () => {
    const md = "# Hello\n\nContent.";
    expect(embedComments(md, [])).toBe(md);
  });
});

describe("extractComments", () => {
  it("extracts a simple comment", () => {
    const md = `# Hello

<!-- @comment id="c1" author="kezia" date="2026-03-26"
A comment.
-->

Content.`;

    const { clean, comments } = extractComments(md);
    expect(comments).toHaveLength(1);
    expect(comments[0].id).toBe("c1");
    expect(comments[0].author).toBe("kezia");
    expect(comments[0].body).toBe("A comment.");
    expect(clean).toContain("# Hello");
    expect(clean).toContain("Content.");
    expect(clean).not.toContain("@comment");
  });

  it("extracts anchored comments", () => {
    const md = `<!-- @comment id="c1" author="kezia" anchor="some text"
Note about this.
-->`;

    const { comments } = extractComments(md);
    expect(comments[0].anchorText).toBe("some text");
  });

  it("extracts threaded comments", () => {
    const md = `<!-- @comment id="p1" author="kezia"
Parent.
-->
<!-- @comment id="r1" author="claude" parent="p1"
Reply.
-->`;

    const { comments } = extractComments(md);
    expect(comments).toHaveLength(2);
    expect(comments[1].parentId).toBe("p1");
  });

  it("extracts resolved flag", () => {
    const md = `<!-- @comment id="c1" author="kezia" resolved
Done.
-->`;

    const { comments } = extractComments(md);
    expect(comments[0].resolved).toBe(true);
  });

  it("round-trips: embed then extract", () => {
    const md = "# Hello\n\nFirst paragraph.\n\nSecond paragraph.";
    const original: SerializedComment[] = [
      makeComment({
        id: "c1",
        body: "Top-level note.",
      }),
      makeComment({
        id: "c2",
        anchorText: "First paragraph.",
        body: "Comment on first.",
      }),
      makeComment({
        id: "c3",
        parentId: "c2",
        author: "claude",
        body: "Reply to first.",
      }),
    ];

    const embedded = embedComments(md, original);
    const { clean, comments } = extractComments(embedded);

    expect(clean).toContain("# Hello");
    expect(clean).toContain("First paragraph.");
    expect(clean).not.toContain("@comment");
    expect(comments).toHaveLength(3);
    expect(comments.find((c) => c.id === "c1")?.body).toBe("Top-level note.");
    expect(comments.find((c) => c.id === "c2")?.anchorText).toBe("First paragraph.");
    expect(comments.find((c) => c.id === "c3")?.parentId).toBe("c2");
  });

  it("returns clean markdown when no comments", () => {
    const md = "# Hello\n\nContent.";
    const { clean, comments } = extractComments(md);
    expect(clean).toBe(md);
    expect(comments).toHaveLength(0);
  });
});
