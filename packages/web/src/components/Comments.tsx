import { useState, useEffect, useCallback, useRef } from "react";

interface Comment {
  id: string;
  body: string;
  anchorText: string | null;
  anchorSection: string | null;
  anchorContext: string | null;
  parentId: string | null;
  resolved: boolean;
  createdAt: string;
  author: { name: string; email: string } | null;
  actorName: string | null;
}

/** Render wiki-links and basic inline markdown in comment text */
function renderCommentBody(body: string, spaceSlug: string): string {
  return body
    // Wiki-links: [[slug|text]] or [[slug]]
    .replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_, slug, text) =>
      `<a href="/s/${spaceSlug}/${slug.trim()}" class="wiki-link">${(text || slug).trim()}</a>`)
    // Bold
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Italic
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Inline code
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // Newlines
    .replace(/\n/g, "<br>");
}

interface Props {
  spaceSlug: string;
  docSlug: string;
  apiUrl: string;
  accessToken: string | null;
  refreshToken: string | null;
}

export default function Comments({
  spaceSlug,
  docSlug,
  apiUrl,
  accessToken: initialAccessToken,
  refreshToken: initialRefreshToken,
}: Props) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [isOpen, setIsOpenState] = useState(false);

  const setIsOpen = (open: boolean) => {
    setIsOpenState(open);
    // Notify layout to collapse/expand sidebar on narrow screens
    document.documentElement.classList.toggle("comments-open", open);
  };
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [newComment, setNewComment] = useState("");
  const [anchorText, setAnchorText] = useState<string | null>(null);
  const [anchorSection, setAnchorSection] = useState<string | null>(null);
  const [anchorContext, setAnchorContext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [composing, setComposing] = useState(false);

  // Mutable token refs so we can refresh without re-rendering everything
  const tokenRef = useRef(initialAccessToken);
  const refreshRef = useRef(initialRefreshToken);

  /** Try to refresh the access token. Returns new token or null. */
  const refreshAccessToken = useCallback(async (): Promise<string | null> => {
    if (!refreshRef.current) return null;

    try {
      const res = await fetch(`${apiUrl}/api/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshRef.current,
          client_id: "sideways-web",
        }),
      });

      if (res.ok) {
        const tokens = await res.json();
        tokenRef.current = tokens.access_token;
        if (tokens.refresh_token) {
          refreshRef.current = tokens.refresh_token;
        }
        return tokens.access_token;
      }

      // Refresh failed — token is invalid/expired, clear both
      tokenRef.current = null;
      refreshRef.current = null;
    } catch {
      tokenRef.current = null;
      refreshRef.current = null;
    }

    return null;
  }, [apiUrl]);

  /** Make an authenticated API call with auto-refresh on 401. */
  const authFetch = useCallback(
    async (url: string, options: RequestInit = {}): Promise<Response> => {
      const doFetch = (token: string | null) => {
        const headers: Record<string, string> = {
          ...((options.headers as Record<string, string>) || {}),
        };
        if (token) headers["Authorization"] = `Bearer ${token}`;
        return fetch(url, { ...options, headers });
      };

      let res = await doFetch(tokenRef.current);

      // On 401, try refreshing the token once
      if (res.status === 401 && refreshRef.current) {
        const newToken = await refreshAccessToken();
        if (newToken) {
          res = await doFetch(newToken);
        }
      }

      return res;
    },
    [refreshAccessToken],
  );

  const fetchComments = useCallback(async () => {
    try {
      const res = await authFetch(
        `${apiUrl}/api/comments/${spaceSlug}/${docSlug}?include_resolved=true`,
      );
      if (res.ok) setComments(await res.json());
    } catch {}
  }, [spaceSlug, docSlug, apiUrl, authFetch]);

  useEffect(() => {
    fetchComments();
  }, [fetchComments]);

  // Listen for custom event from vanilla JS selection handler
  useEffect(() => {
    function handleInlineComment(e: Event) {
      const detail = (e as CustomEvent).detail;
      setNewComment("");
      setReplyTo(null);
      setError(null);
      setAnchorText(detail.anchorText);
      setAnchorSection(detail.anchorSection || null);
      setAnchorContext(detail.anchorContext || null);
      setComposing(true);
      setIsOpen(true);
    }

    document.addEventListener("sideways:inline-comment", handleInlineComment);
    return () =>
      document.removeEventListener(
        "sideways:inline-comment",
        handleInlineComment,
      );
  }, []);

  // Open panel and scroll to comment if URL has #comment-{id}
  const pendingScrollId = useRef<string | null>(null);

  function handleCommentHash() {
    const hash = window.location.hash;
    if (!hash.startsWith("#comment-")) return;
    const commentId = hash.slice(9);
    history.replaceState(null, "", window.location.pathname);
    pendingScrollId.current = commentId;
    setIsOpen(true);
  }

  // Check hash on mount + listen for hash changes (same-page navigation)
  useEffect(() => {
    handleCommentHash();
    window.addEventListener("hashchange", handleCommentHash);
    return () => window.removeEventListener("hashchange", handleCommentHash);
  }, []);

  // When panel is open and we have a pending scroll target, poll for it
  useEffect(() => {
    if (!isOpen || !pendingScrollId.current) return;
    const targetId = pendingScrollId.current;

    let attempts = 0;
    const tryScroll = () => {
      const el = document.querySelector(`[data-comment-thread="${targetId}"]`);
      if (el) {
        pendingScrollId.current = null;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("comment-flash");
        setTimeout(() => el.classList.remove("comment-flash"), 2000);
      } else if (attempts < 40) {
        attempts++;
        setTimeout(tryScroll, 100);
      } else {
        pendingScrollId.current = null;
      }
    };
    tryScroll();
  }, [isOpen, comments.length]);

  // Mark anchor text in the document with subtle highlights
  useEffect(() => {
    const docContent = document.querySelector(".sw-doc-content");
    if (!docContent) return;

    // Remove previous gutter markers
    docContent.querySelectorAll(".comment-gutter-mark, .comment-gutter-target").forEach(el => el.remove());

    // Add gutter markers for each anchored, unresolved comment
    const anchored = comments.filter((c) => c.anchorText && !c.parentId && !c.resolved);
    const contentRect = docContent.getBoundingClientRect();

    for (const comment of anchored) {
      const target = findTextInDOM(docContent, comment.anchorText!) as HTMLElement | null;
      if (target) {
        // Position bar and click target relative to the content container
        target.style.position = "relative";

        // Invisible click target on the block itself
        const clickTarget = document.createElement("div");
        clickTarget.className = "comment-gutter-target";
        clickTarget.title = "View comment";
        clickTarget.addEventListener("click", (e) => {
          e.stopPropagation();
          setIsOpen(true);
          setTimeout(() => {
            const el = document.querySelector(`[data-comment-thread="${comment.id}"]`);
            el?.scrollIntoView({ behavior: "smooth", block: "center" });
          }, 100);
        });
        target.appendChild(clickTarget);

        // Gutter bar positioned on the content container
        const targetRect = target.getBoundingClientRect();
        const bar = document.createElement("div");
        bar.className = "comment-gutter-mark";
        bar.dataset.commentId = comment.id;
        bar.style.top = `${targetRect.top - contentRect.top}px`;
        bar.style.height = `${targetRect.height}px`;
        docContent.appendChild(bar);
      }
    }
  }, [comments]);

  const submitComment = async () => {
    if (!newComment.trim()) return;
    setError(null);
    setSubmitting(true);

    try {
      const res = await authFetch(
        `${apiUrl}/api/comments/${spaceSlug}/${docSlug}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            body: newComment,
            anchorText: replyTo ? null : anchorText,
            anchorSection: replyTo ? null : anchorSection,
            anchorContext: replyTo ? null : anchorContext,
            parentId: replyTo,
          }),
        },
      );

      if (res.ok) {
        setNewComment("");
        setAnchorText(null);
        setAnchorSection(null);
        setAnchorContext(null);
        setReplyTo(null);
        setComposing(false);
        await fetchComments();
      } else if (res.status === 401) {
        setError("Session expired. Please sign in again.");
      } else {
        setError(`Failed to post comment (${res.status})`);
      }
    } catch (e) {
      setError("Connection error. Is the server running?");
    } finally {
      setSubmitting(false);
    }
  };

  const resolveComment = async (id: string) => {
    const res = await authFetch(
      `${apiUrl}/api/comments/${spaceSlug}/${docSlug}/${id}/resolve`,
      { method: "POST" },
    );
    if (res.ok) await fetchComments();
  };

  const isAuthenticated = !!tokenRef.current;
  const topLevel = comments.filter((c) => !c.parentId && !c.resolved);
  const resolved = comments.filter((c) => !c.parentId && c.resolved);
  const replies = comments.filter((c) => c.parentId);
  const replyMap = new Map<string, Comment[]>();
  for (const r of replies) {
    const list = replyMap.get(r.parentId!) || [];
    list.push(r);
    replyMap.set(r.parentId!, list);
  }

  const totalCount = topLevel.length; // only open comments in badge

  return (
    <div className="comments-wrapper">
      <button
        className="comments-toggle"
        onClick={() => setIsOpen(!isOpen)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span>{isOpen ? "Hide" : "Comments"}</span>
        {totalCount > 0 && <span className="comments-badge">{totalCount}</span>}
      </button>

      {isOpen && (
        <div className="comments-panel-overlay">
          <div className="comments-panel-header">
            <h3>Comments</h3>
            <button className="panel-close" onClick={() => setIsOpen(false)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {isAuthenticated && !composing && !replyTo && !anchorText && (
            <div className="comment-form-collapsed">
              <button
                type="button"
                className="comment-compose-trigger"
                onClick={() => setComposing(true)}
              >
                Add a comment…
              </button>
            </div>
          )}

          {isAuthenticated && (composing || replyTo || anchorText) && (
            <form className="comment-form" onSubmit={(e) => { e.preventDefault(); submitComment(); }}>
              {anchorText && !replyTo && (
                <div className="comment-form-anchor">
                  <span>"{anchorText.slice(0, 60)}{anchorText.length > 60 ? "…" : ""}"</span>
                  <button type="button" onClick={() => { setAnchorText(null); setAnchorSection(null); setAnchorContext(null); }}>×</button>
                </div>
              )}
              <textarea
                autoFocus
                ref={(el) => {
                  if (el) {
                    el.style.height = "auto";
                    el.style.height = Math.max(el.scrollHeight, 32) + "px";
                  }
                }}
                value={newComment}
                onChange={(e) => {
                  setNewComment(e.target.value);
                  const el = e.target;
                  el.style.height = "auto";
                  el.style.height = Math.max(el.scrollHeight, 32) + "px";
                }}
                placeholder={
                  replyTo ? "Write a reply…"
                    : anchorText ? "Add your comment…"
                    : "Write a comment…"
                }
                rows={1}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.metaKey) submitComment();
                }}
              />
              {error && <div className="comment-form-error">{error}</div>}
              <div className="comment-form-actions">
                <button
                  type="button"
                  className="comment-form-cancel"
                  onClick={() => {
                    setReplyTo(null);
                    setAnchorText(null);
                    setNewComment("");
                    setError(null);
                    setComposing(false);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="comment-form-submit"
                  disabled={!newComment.trim() || submitting}
                >
                  {submitting ? "Posting…" : "Comment"}
                </button>
              </div>
            </form>
          )}

          <div className="comments-list">
            {topLevel.length === 0 && resolved.length === 0 && (
              <p className="comments-empty">
                No comments yet.
                {isAuthenticated
                  ? " Select text to add an inline comment."
                  : " Sign in to comment."}
              </p>
            )}

            {topLevel.map((comment) => (
              <div key={comment.id} className="comment-thread" data-comment-thread={comment.id}>
                <CommentItem spaceSlug={spaceSlug}
                  comment={comment}
                  onReply={() => {
                    setReplyTo(comment.id);
                    setAnchorText(null);
                    setError(null);
                    setComposing(true);
                  }}
                  onResolve={() => resolveComment(comment.id)}
                  canAct={isAuthenticated}
                />
                {(replyMap.get(comment.id) || []).map((reply) => (
                  <CommentItem spaceSlug={spaceSlug}
                    key={reply.id}
                    comment={reply}
                    isReply
                    onReply={() => {
                      setReplyTo(comment.id);
                      setAnchorText(null);
                      setError(null);
                      setComposing(true);
                    }}
                    canAct={isAuthenticated}
                  />
                ))}
              </div>
            ))}

            {resolved.length > 0 && (
              <details className="resolved-section">
                <summary>
                  {resolved.length} resolved comment{resolved.length !== 1 ? "s" : ""}
                </summary>
                {resolved.map((comment) => (
                  <div key={comment.id} className="comment-thread resolved" data-comment-thread={comment.id}>
                    <CommentItem spaceSlug={spaceSlug}
                      comment={comment}
                      onReply={() => {
                        setReplyTo(comment.id);
                        setAnchorText(null);
                        setError(null);
                        setComposing(true);
                      }}
                      onResolve={() => resolveComment(comment.id)}
                      canAct={isAuthenticated}
                    />
                    {(replyMap.get(comment.id) || []).map((reply) => (
                      <CommentItem spaceSlug={spaceSlug}
                        key={reply.id}
                        comment={reply}
                        isReply
                        onReply={() => {
                          setReplyTo(comment.id);
                          setAnchorText(null);
                          setError(null);
                          setComposing(true);
                        }}
                        canAct={isAuthenticated}
                      />
                    ))}
                  </div>
                ))}
              </details>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Find a text string in the DOM that may span multiple elements.
 * Returns the containing element (smallest block parent) or null.
 */
function findTextInDOM(root: Element, searchText: string): Element | null {
  // Search in the concatenated textContent of block-level elements
  const blocks = root.querySelectorAll("p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, pre, dd, dt");
  const needle = searchText.slice(0, 80).toLowerCase();

  for (const block of blocks) {
    const text = (block.textContent || "").toLowerCase();
    if (text.includes(needle)) {
      return block as Element;
    }
  }

  // Fallback: search the whole content
  const fullText = (root.textContent || "").toLowerCase();
  if (fullText.includes(needle)) {
    // Walk text nodes to find approximate location
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const nodeText = (node.textContent || "").toLowerCase();
      if (nodeText.includes(needle.slice(0, 30))) {
        return node.parentElement;
      }
    }
  }

  return null;
}

/** Find anchor text in the document and scroll to it with a flash highlight */
function scrollToAnchor(anchorText: string, section: string | null) {
  const docContent = document.querySelector(".sw-doc-content");
  if (!docContent) return;

  const target = findTextInDOM(docContent, anchorText);
  if (!target) return;

  // Scroll to the element
  target.scrollIntoView({ behavior: "smooth", block: "center" });

  // Flash highlight overlay
  const rect = target.getBoundingClientRect();
  const highlight = document.createElement("div");
  highlight.className = "comment-scroll-highlight";
  highlight.style.position = "absolute";
  highlight.style.left = `${rect.left + window.scrollX - 4}px`;
  highlight.style.top = `${rect.top + window.scrollY - 2}px`;
  highlight.style.width = `${rect.width + 8}px`;
  highlight.style.height = `${rect.height + 4}px`;
  document.body.appendChild(highlight);

  setTimeout(() => highlight.remove(), 2000);
}

function CommentItem({
  comment,
  spaceSlug,
  isReply,
  onReply,
  onResolve,
  canAct,
}: {
  comment: Comment;
  spaceSlug: string;
  isReply?: boolean;
  onReply?: () => void;
  onResolve?: () => void;
  canAct: boolean;
}) {
  return (
    <div className={`comment-item ${isReply ? "reply" : ""}`}>
      {comment.anchorSection && (
        <div className="comment-section-path">{comment.anchorSection}</div>
      )}
      {comment.anchorText && (
        <div
          className="comment-anchor"
          role="button"
          tabIndex={0}
          onClick={() => scrollToAnchor(comment.anchorText!, comment.anchorSection)}
          onKeyDown={(e) => { if (e.key === "Enter") scrollToAnchor(comment.anchorText!, comment.anchorSection); }}
        >
          {comment.anchorContext ? (
            // Show context with anchor text highlighted within it
            (() => {
              const ctx = comment.anchorContext;
              const idx = ctx.indexOf(comment.anchorText.slice(0, 40));
              if (idx >= 0) {
                const before = ctx.slice(Math.max(0, idx - 40), idx);
                const match = ctx.slice(idx, idx + comment.anchorText.length);
                const after = ctx.slice(idx + comment.anchorText.length, idx + comment.anchorText.length + 40);
                return (
                  <>
                    {before.length > 0 && idx > 40 && "…"}{before}<mark>{match}</mark>{after}{after.length >= 40 && "…"}
                  </>
                );
              }
              return <>"{comment.anchorText.slice(0, 80)}{comment.anchorText.length > 80 ? "…" : ""}"</>;
            })()
          ) : (
            <>"{comment.anchorText.slice(0, 80)}{comment.anchorText.length > 80 ? "…" : ""}"</>
          )}
        </div>
      )}
      <div className="comment-meta">
        <span className="comment-author">
          {comment.actorName
            ? <>{comment.actorName} <span className="comment-via">via {comment.author?.name}</span></>
            : comment.author?.name || "Unknown"}
        </span>
        <span className="comment-date">{new Date(comment.createdAt).toLocaleDateString()}</span>
      </div>
      <div className="comment-body" dangerouslySetInnerHTML={{ __html: renderCommentBody(comment.body, spaceSlug) }} />
      {canAct && (
        <div className="comment-actions">
          {onReply && <button onClick={onReply} className="comment-action">Reply</button>}
          {onResolve && (
            <button onClick={onResolve} className="comment-action">
              {comment.resolved ? "Reopen" : "Resolve"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
