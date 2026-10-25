import { describe, it, expect } from "vitest";
import { formatUnifiedDiff } from "../diff.js";

describe("formatUnifiedDiff", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

  it("returns an empty string when the texts match", () => {
    expect(formatUnifiedDiff("a", "b", "x\ny\n", "x\ny")).toBe("");
  });

  it("shows an inserted line as one addition, not a cascade", () => {
    const old = lines(10);
    const next = [...old.slice(0, 5), "inserted", ...old.slice(5)];
    expect(formatUnifiedDiff("a", "b", old.join("\n"), next.join("\n"))).toBe(
      [
        "--- a",
        "+++ b",
        "@@ -3,6 +3,7 @@",
        " line 3",
        " line 4",
        " line 5",
        "+inserted",
        " line 6",
        " line 7",
        " line 8",
      ].join("\n"),
    );
  });

  it("splits distant changes into separate hunks", () => {
    const old = lines(20);
    const next = [...old];
    next[1] = "changed 2";
    next[18] = "changed 19";
    const out = formatUnifiedDiff("a", "b", old.join("\n"), next.join("\n"));
    expect(out.split("\n").filter((l) => l.startsWith("@@"))).toEqual([
      "@@ -1,5 +1,5 @@",
      "@@ -16,5 +16,5 @@",
    ]);
    expect(out).toContain("-line 2\n+changed 2");
    expect(out).toContain("-line 19\n+changed 19");
  });

  it("writes an empty old range as the line before it", () => {
    expect(formatUnifiedDiff("a", "b", "", "new")).toBe(["--- a", "+++ b", "@@ -0,0 +1 @@", "+new"].join("\n"));
  });

  it("colours only when asked", () => {
    expect(formatUnifiedDiff("a", "b", "x", "y")).not.toContain("\x1b[");
    expect(formatUnifiedDiff("a", "b", "x", "y", { color: true })).toContain("\x1b[31m-x\x1b[0m");
  });
});
