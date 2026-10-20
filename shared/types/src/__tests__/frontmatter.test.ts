import { describe, it, expect } from "vitest";
import { frontmatterHashInput } from "../index.js";

describe("frontmatterHashInput", () => {
  it("adds nothing when there is no frontmatter", () => {
    expect(frontmatterHashInput(null)).toBe("");
    expect(frontmatterHashInput(undefined)).toBe("");
    expect(frontmatterHashInput({})).toBe("");
  });

  it("ignores key order, at every level", () => {
    expect(frontmatterHashInput({ b: 1, a: { d: [1, 2], c: "x" } })).toBe(
      frontmatterHashInput({ a: { c: "x", d: [1, 2] }, b: 1 }),
    );
  });

  it("keeps array order", () => {
    expect(frontmatterHashInput({ repos: ["a", "b"] })).not.toBe(
      frontmatterHashInput({ repos: ["b", "a"] }),
    );
  });
});
