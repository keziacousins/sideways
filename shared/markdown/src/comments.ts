/**
 * Comment serialization for markdown.
 *
 * Format:
 * <!-- @comment id="abc" author="kezia" date="2026-03-26" [parent="def"] [resolved]
 * Comment body here.
 * Can be multi-line.
 * -->
 *
 * Anchored comments are placed immediately after the line containing
 * their anchor text. Unanchored (page-level) comments go at the top.
 */

export interface SerializedComment {
  id: string;
  author: string;
  authorEmail?: string;
  date: string;
  body: string;
  anchorText: string | null;
  anchorSection: string | null;
  anchorContext: string | null;
  parentId: string | null;
  resolved: boolean;
}

const COMMENT_REGEX =
  /<!-- @comment\s+([\s\S]*?)-->/g;

const ATTR_REGEX = /(\w+)="([^"]*)"/g;

/**
 * Extract comments from markdown content.
 * Returns the clean markdown (without comment blocks) and the parsed comments.
 */
export function extractComments(markdown: string): {
  clean: string;
  comments: SerializedComment[];
} {
  const comments: SerializedComment[] = [];

  const clean = markdown.replace(COMMENT_REGEX, (match) => {
    // Parse the opening line for attributes
    const firstLineEnd = match.indexOf("\n");
    const headerLine =
      firstLineEnd > 0 ? match.slice(0, firstLineEnd) : match;

    const attrs: Record<string, string> = {};
    let m: RegExpExecArray | null;
    const attrRegex = new RegExp(ATTR_REGEX.source, "g");
    while ((m = attrRegex.exec(headerLine))) {
      attrs[m[1]] = m[2];
    }

    if (!attrs.id || !attrs.author) return ""; // malformed, strip

    // Body is everything between the first line and -->
    const bodyStart = firstLineEnd > 0 ? firstLineEnd + 1 : match.length;
    const bodyEnd = match.lastIndexOf("-->");
    const body = match.slice(bodyStart, bodyEnd).trim();

    comments.push({
      id: attrs.id,
      author: attrs.author,
      authorEmail: attrs.email,
      date: attrs.date || "",
      body,
      anchorText: attrs.anchor || null,
      anchorSection: attrs.section || null,
      anchorContext: attrs.context || null,
      parentId: attrs.parent || null,
      resolved: headerLine.includes(" resolved"),
    });

    return "";
  });

  // Only clean up if we actually removed comments
  const cleaned = comments.length > 0
    ? clean.replace(/\n{3,}/g, "\n\n").trim()
    : clean;

  return { clean: cleaned, comments };
}

/**
 * Embed comments into markdown content.
 * Anchored comments are placed after the first line containing the anchor text.
 * Unanchored and orphaned comments go at the top.
 */
export function embedComments(
  markdown: string,
  comments: SerializedComment[],
): string {
  if (comments.length === 0) return markdown;

  // Separate anchored from unanchored
  const anchored = comments.filter((c) => c.anchorText && !c.parentId);
  const unanchored = comments.filter((c) => !c.anchorText && !c.parentId);
  const replies = comments.filter((c) => c.parentId);

  // Build a map of parent -> replies
  const replyMap = new Map<string, SerializedComment[]>();
  for (const reply of replies) {
    const list = replyMap.get(reply.parentId!) || [];
    list.push(reply);
    replyMap.set(reply.parentId!, list);
  }

  function formatComment(comment: SerializedComment): string {
    const attrs: string[] = [
      `id="${comment.id}"`,
      `author="${comment.author}"`,
    ];
    if (comment.authorEmail) attrs.push(`email="${comment.authorEmail}"`);
    if (comment.date) attrs.push(`date="${comment.date}"`);
    if (comment.anchorText) attrs.push(`anchor="${comment.anchorText}"`);
    if (comment.anchorSection) attrs.push(`section="${comment.anchorSection}"`);
    if (comment.parentId) attrs.push(`parent="${comment.parentId}"`);
    if (comment.resolved) attrs.push("resolved");

    return `<!-- @comment ${attrs.join(" ")}\n${comment.body}\n-->`;
  }

  function formatThread(comment: SerializedComment): string {
    let result = formatComment(comment);
    const threadReplies = replyMap.get(comment.id) || [];
    for (const reply of threadReplies) {
      result += "\n" + formatComment(reply);
    }
    return result;
  }

  // Start with unanchored comments at top
  let result = markdown;
  if (unanchored.length > 0) {
    const header = unanchored.map(formatThread).join("\n\n");
    result = header + "\n\n" + result;
  }

  // Insert anchored comments after their anchor text
  const lines = result.split("\n");
  const output: string[] = [];
  const placed = new Set<string>();

  for (const line of lines) {
    output.push(line);

    for (const comment of anchored) {
      if (!placed.has(comment.id) && line.includes(comment.anchorText!)) {
        output.push("");
        output.push(formatThread(comment));
        placed.add(comment.id);
      }
    }
  }

  // Any anchored comments that couldn't find their anchor go at the top
  const orphaned = anchored.filter((c) => !placed.has(c.id));
  if (orphaned.length > 0) {
    const orphanBlock = orphaned.map(formatThread).join("\n\n");
    return orphanBlock + "\n\n" + output.join("\n");
  }

  return output.join("\n");
}
