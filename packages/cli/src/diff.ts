/**
 * Unified diff output for `sideways diff`, in the shape of `diff -u`:
 * `---`/`+++` headers, then `@@` hunks with three lines of context.
 */

import { structuredPatch } from "diff";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/**
 * Format the difference between `oldText` and `newText` as a unified diff.
 * Trailing whitespace at the end of either text is ignored, so a missing
 * final newline is not reported as a change. Returns "" when the texts match.
 */
export function formatUnifiedDiff(
  oldName: string,
  newName: string,
  oldText: string,
  newText: string,
  opts: { color?: boolean; context?: number } = {},
): string {
  const patch = structuredPatch(
    oldName,
    newName,
    normalizeEnd(oldText),
    normalizeEnd(newText),
    undefined,
    undefined,
    { context: opts.context ?? 3 },
  );
  if (patch.hunks.length === 0) return "";

  const paint = (code: string, s: string) => (opts.color ? `${code}${s}${RESET}` : s);
  const out = [paint(BOLD, `--- ${oldName}`), paint(BOLD, `+++ ${newName}`)];
  for (const h of patch.hunks) {
    out.push(paint(CYAN, `@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@`));
    for (const line of h.lines) {
      if (line.startsWith("-")) out.push(paint(RED, line));
      else if (line.startsWith("+")) out.push(paint(GREEN, line));
      else out.push(line);
    }
  }
  return out.join("\n");
}

/** Trim trailing whitespace and end on one newline; an empty text stays empty. */
function normalizeEnd(text: string): string {
  const t = text.trimEnd();
  return t ? t + "\n" : "";
}

/**
 * A hunk range as `diff -u` writes it: the count is omitted when it is 1, and
 * an empty range names the line before it (jsdiff's `formatPatch` does the same).
 */
function range(start: number, count: number): string {
  if (count === 0) return `${start - 1},0`;
  return count === 1 ? `${start}` : `${start},${count}`;
}
