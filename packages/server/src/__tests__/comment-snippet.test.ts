import { describe, it, expect } from "vitest";
import { commentSnippet } from "../lib/activity.js";

describe("commentSnippet", () => {
  it("leaves plain text alone", () => {
    expect(commentSnippet("Looks good to me.")).toBe("Looks good to me.");
  });

  it("folds a multi-line body onto one line", () => {
    expect(commentSnippet("First line.\n\nSecond   line.")).toBe("First line. Second line.");
  });

  it("drops emphasis, code and block markers", () => {
    expect(commentSnippet("## Heading\n\n> quoted **bold** and `code`\n\n- item one\n1. item two"))
      .toBe("Heading quoted bold and code item one item two");
  });

  it("keeps the text of links, images and wiki-links", () => {
    expect(commentSnippet("See [the guide](https://example.com/a) and [[auth|Auth doc]] or [[setup]]."))
      .toBe("See the guide and Auth doc or setup.");
  });

  it("keeps mentions and snake_case intact", () => {
    expect(commentSnippet("@kezia.c check max_retries")).toBe("@kezia.c check max_retries");
  });

  it("drops fence markers but keeps the code", () => {
    expect(commentSnippet("Try:\n```ts\nconst a = 1;\n```")).toBe("Try: const a = 1;");
  });

  it("truncates a long body with an ellipsis", () => {
    const snippet = commentSnippet("word ".repeat(100));
    expect(snippet.length).toBeLessThanOrEqual(160);
    expect(snippet.endsWith("…")).toBe(true);
  });
});
