/**
 * Remark plugin: transforms [[slug]] and [[slug|display text]] into markdown links.
 * The space slug is injected at creation time to build the correct URL.
 */

import { visit } from "unist-util-visit";
import type { Root, Text } from "mdast";

const WIKI_LINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;

export function remarkWikiLinks(spaceSlug?: string) {
  return () => (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === undefined) return;

      const text = node.value;
      if (!text.includes("[[")) return;

      const children: any[] = [];
      let lastIdx = 0;

      for (const match of text.matchAll(WIKI_LINK_RE)) {
        const [full, slug, displayText] = match;
        const matchIdx = match.index!;

        // Text before the match
        if (matchIdx > lastIdx) {
          children.push({ type: "text", value: text.slice(lastIdx, matchIdx) });
        }

        // Build the link
        const href = spaceSlug ? `/s/${spaceSlug}/${slug.trim()}` : slug.trim();
        const label = (displayText || slug).trim();

        children.push({
          type: "link",
          url: href,
          children: [{ type: "text", value: label }],
          data: { hProperties: { className: ["wiki-link"] } },
        });

        lastIdx = matchIdx + full.length;
      }

      // Text after the last match
      if (lastIdx < text.length) {
        children.push({ type: "text", value: text.slice(lastIdx) });
      }

      if (children.length > 0) {
        parent.children.splice(index, 1, ...children);
      }
    });
  };
}
