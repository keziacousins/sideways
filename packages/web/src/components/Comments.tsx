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

  // Mark anchor text in the document with subtle highlights
  useEffect(() => {
    const docContent = document.querySelector(".sw-doc-content");
    if (!docContent) return;

    // Remove previous markers
    docContent.querySelectorAll(".comment-marker").forEach((el) => {
      const parent = el.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(el.textContent || ""), el);
        parent.normalize();
      }
    });

    // Add markers for each anchored, unresolved comment
    const anchored = comments.filter((c) => c.anchorText && !c.parentId && !c.resolved);
    for (const comment of anchored) {
      const text = comment.anchorText!;
      const walker = document.createTreeWalker(docContent, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const textNode = walker.currentNode as Text;
        const idx = textNode.textContent?.indexOf(text.slice(0, 60)) ?? -1;
        if (idx >= 0) {
          const range = document.createRange();
          range.setStart(textNode, idx);
          range.setEnd(textNode, Math.min(idx + text.length, textNode.length));
          const mark = document.createElement("span");
          mark.className = "comment-marker";
          mark.dataset.commentId = comment.id;
          mark.title = "View comment";
          mark.addEventListener("click", () => {
            setIsOpen(true);
            // Scroll the comment into view in the panel
            setTimeout(() => {
              const el = document.querySelector(`[data-comment-thread="${comment.id}"]`);
              el?.scrollIntoView({ behavior: "smooth", block: "center" });
            }, 100);
          });
          range.surroundContents(mark);
          break; // Only mark first occurrence
        }
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

  const totalCount = topLevel.length + resolved.length;

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
                <CommentItem
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
                  <CommentItem
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
                    <CommentItem
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
                      <CommentItem
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

/** Find anchor text in the document and scroll to it with a flash highlight */
function scrollToAnchor(anchorText: string, section: string | null) {
  const docContent = document.querySelector(".sw-doc-content");
  if (!docContent) return;

  // Use TreeWalker to find text nodes containing the anchor text
  const walker = document.createTreeWalker(docContent, NodeFilter.SHOW_TEXT);
  let best: { node: Text; index: number } | null = null;

  while (walker.nextNode()) {
    const textNode = walker.currentNode as Text;
    const idx = textNode.textContent?.indexOf(anchorText.slice(0, 60)) ?? -1;
    if (idx >= 0) {
      // If we have a section, prefer matches within that section
      if (section) {
        const headings = Array.from(docContent.querySelectorAll("h1,h2,h3,h4,h5,h6"));
        const nodeTop = textNode.parentElement?.getBoundingClientRect().top ?? 0;
        const above = headings.filter(h => h.getBoundingClientRect().top < nodeTop);
        const lastHeading = above[above.length - 1]?.textContent?.trim() || "";
        if (section.includes(lastHeading)) {
          best = { node: textNode, index: idx };
          break; // Exact section match, use this one
        }
      }
      if (!best) {
        best = { node: textNode, index: idx };
      }
    }
  }

  if (!best) return;

  // Create a temporary highlight using the Range API
  const range = document.createRange();
  range.setStart(best.node, best.index);
  range.setEnd(best.node, Math.min(best.index + anchorText.length, best.node.length));

  const rect = range.getBoundingClientRect();
  const highlight = document.createElement("div");
  highlight.className = "comment-scroll-highlight";
  highlight.style.position = "absolute";
  highlight.style.left = `${rect.left + window.scrollX - 4}px`;
  highlight.style.top = `${rect.top + window.scrollY - 2}px`;
  highlight.style.width = `${rect.width + 8}px`;
  highlight.style.height = `${rect.height + 4}px`;
  document.body.appendChild(highlight);

  // Scroll into view
  const el = best.node.parentElement;
  el?.scrollIntoView({ behavior: "smooth", block: "center" });

  // Remove highlight after animation
  setTimeout(() => highlight.remove(), 2000);
}

function CommentItem({
  comment,
  isReply,
  onReply,
  onResolve,
  canAct,
}: {
  comment: Comment;
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
        <span className="comment-author">{comment.author?.name || "Unknown"}</span>
        <span className="comment-date">{new Date(comment.createdAt).toLocaleDateString()}</span>
      </div>
      <div className="comment-body">{comment.body}</div>
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
