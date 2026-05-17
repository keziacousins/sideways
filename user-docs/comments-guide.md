# Comments & Review

## Adding Comments

### From the Web

1. **Page-level comment**: Open the comments panel and type in the compose box
2. **Inline comment**: Select text in the document, click the comment button that appears, then write your comment anchored to that passage

Anchored comments show a gold gutter bar next to the relevant paragraph. Click the bar to open the comments panel and see the thread.

### From the CLI

```bash
sideways comment docs/api-design.md "Should we use UUIDs here?"
```

With anchor:

```bash
sideways comment docs/api-design.md "Needs clarification" \
  --anchor "All IDs are auto-incrementing integers"
```

Reply to a comment:

```bash
sideways comment docs/api-design.md "Good point" --reply <comment-id>
```

### From MCP (AI Agents)

The `comment_add` tool lets AI agents leave comments. The doc is identified by its ref (`<space>:<section>/<path>.md`):

```
comment_add(ref="engineering:architecture/api-design.md",
  body="Should we use UUIDs here?",
  anchor_text="All IDs are auto-incrementing integers")
```

## Threads & Replies

Comments are threaded. Click "Reply" on any comment to respond in the thread. Replies are indented below the parent comment.

## Resolving Comments

Click "Resolve" on a comment to mark the discussion as complete. Resolved comments are hidden by default but can be shown by expanding the "Resolved" section.

From the CLI:

```bash
sideways resolve <comment-id>
```

(The CLI looks up the comment by its ID — no doc path needed.)

## Formatting in Comments

Comments support inline markdown:

- `**bold**` and `*italic*`
- `` `inline code` ``
- Wiki-links: `[[section/path|Display text]]` — the target is used verbatim as the URL path after `/s/<space>/`, so include the section
- Line breaks

Wiki-link resolution in comments is simpler than in documents: there's no same-directory or same-section fallback. Use the full `section/path` form for a working link.

## Notifications

You receive notifications when:

- Someone **replies** to your comment
- Someone **@mentions** you in a comment (`@your-name` or `@your-email`)
- A **watched document** gets a new comment or is updated

The notification bell in the header shows your unread count. Click a notification to navigate directly to the relevant comment.

## Watching Documents

Click the bell icon in the document toolbar to watch a document. You'll be notified of:

- New comments on the document
- Document content updates (new versions)

Commenting on a document automatically watches it.

## @Mentions

Mention a user in a comment by typing their name or email:

```
@kezia What do you think about this approach?
```

The mentioned user receives a notification.

## Agent Comments

When an AI agent posts a comment via an API key with an actor name, or using the `--as` flag, comments show the agent identity:

> **Claude via Kezia Crawford-Cousins** · 28/03/2026
> Good point — the tsvector recomputation is a single SQL UPDATE...

The real user is always visible alongside the agent name.
