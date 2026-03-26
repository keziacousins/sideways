import { useState, useEffect, useRef, useCallback } from "react";

interface Comment {
  id: string;
  body: string;
  anchorText: string | null;
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
}

export default function Comments({
  spaceSlug,
  docSlug,
  apiUrl,
  accessToken,
}: Props) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [newComment, setNewComment] = useState("");
  const [anchorText, setAnchorText] = useState<string | null>(null);
  const [selectionPos, setSelectionPos] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

  const fetchComments = useCallback(async () => {
    try {
      const res = await fetch(
        `${apiUrl}/api/comments/${spaceSlug}/${docSlug}?include_resolved=true`,
        { headers },
      );
      if (res.ok) setComments(await res.json());
    } catch {}
  }, [spaceSlug, docSlug, apiUrl]);

  useEffect(() => {
    fetchComments();
  }, [fetchComments]);

  // Text selection handler — show floating button
  useEffect(() => {
    function handleMouseUp() {
      // Small delay to let the selection finalize
      requestAnimationFrame(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.toString().trim()) {
          setSelectionPos(null);
          return;
        }

        // Only trigger for selections inside the document content
        const docContent = sel.anchorNode?.parentElement?.closest(".sw-doc-content");
        if (!docContent) {
          setSelectionPos(null);
          return;
        }

        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        // Position: just to the right of the content area, vertically aligned with selection
        const contentRect = docContent.getBoundingClientRect();

        setSelectionPos({
          x: contentRect.right + 16,
          y: rect.top + window.scrollY + (rect.height / 2) - 14,
        });
        setAnchorText(sel.toString().trim().slice(0, 200));
      });
    }

    function handleMouseDown(e: MouseEvent) {
      // Clear selection button if clicking outside it
      const target = e.target as HTMLElement;
      if (!target.closest(".selection-comment-btn")) {
        setSelectionPos(null);
      }
    }

    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, []);

  const openWithAnchor = (text: string | null) => {
    setAnchorText(text);
    setReplyTo(null);
    setIsOpen(true);
    setSelectionPos(null);
    window.getSelection()?.removeAllRanges();
  };

  const submitComment = async () => {
    if (!newComment.trim()) return;

    try {
      const res = await fetch(
        `${apiUrl}/api/comments/${spaceSlug}/${docSlug}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            body: newComment,
            anchorText: replyTo ? null : anchorText,
            parentId: replyTo,
          }),
        },
      );

      if (res.ok) {
        setNewComment("");
        setAnchorText(null);
        setReplyTo(null);
        await fetchComments();
      }
    } catch {}
  };

  const resolveComment = async (id: string) => {
    await fetch(
      `${apiUrl}/api/comments/${spaceSlug}/${docSlug}/${id}/resolve`,
      { method: "POST", headers },
    );
    await fetchComments();
  };

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
    <>
      {/* Toggle button in toolbar area */}
      <button
        className="comments-toggle"
        onClick={() => setIsOpen(!isOpen)}
        data-count={totalCount || undefined}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span>{isOpen ? "Hide" : "Comments"}</span>
        {totalCount > 0 && (
          <span className="comments-badge">{totalCount}</span>
        )}
      </button>

      {/* Floating "Add comment" button on text selection */}
      {selectionPos && accessToken && (
        <button
          className="selection-comment-btn"
          style={{
            position: "absolute",
            left: `${selectionPos.x}px`,
            top: `${selectionPos.y}px`,
          }}
          onClick={() => openWithAnchor(anchorText)}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          Comment
        </button>
      )}

      {/* Comments panel */}
      {isOpen && (
        <div className="comments-panel-overlay" ref={panelRef}>
          <div className="comments-panel-header">
            <h3>Comments</h3>
            <button className="panel-close" onClick={() => setIsOpen(false)}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* New comment form */}
          {accessToken && (
            <div className="comment-form">
              {anchorText && !replyTo && (
                <div className="comment-form-anchor">
                  <span>
                    Commenting on: "
                    {anchorText.slice(0, 60)}
                    {anchorText.length > 60 ? "…" : ""}"
                  </span>
                  <button onClick={() => setAnchorText(null)}>×</button>
                </div>
              )}
              <textarea
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder={
                  replyTo
                    ? "Write a reply…"
                    : anchorText
                      ? "Add your comment…"
                      : "Add a page comment…"
                }
                rows={3}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.metaKey) submitComment();
                }}
              />
              <div className="comment-form-actions">
                {(replyTo || anchorText) && (
                  <button
                    className="comment-form-cancel"
                    onClick={() => {
                      setReplyTo(null);
                      setAnchorText(null);
                      setNewComment("");
                    }}
                  >
                    Cancel
                  </button>
                )}
                <button
                  className="comment-form-submit"
                  onClick={submitComment}
                  disabled={!newComment.trim()}
                >
                  Comment
                </button>
              </div>
            </div>
          )}

          {/* Comment threads */}
          <div className="comments-list">
            {topLevel.length === 0 && resolved.length === 0 && (
              <p className="comments-empty">
                No comments yet.
                {accessToken
                  ? " Select text to add an inline comment."
                  : " Sign in to comment."}
              </p>
            )}

            {topLevel.map((comment) => (
              <div key={comment.id} className="comment-thread">
                <CommentItem
                  comment={comment}
                  onReply={() => {
                    setReplyTo(comment.id);
                    setAnchorText(null);
                  }}
                  onResolve={() => resolveComment(comment.id)}
                  canAct={!!accessToken}
                />
                {(replyMap.get(comment.id) || []).map((reply) => (
                  <CommentItem
                    key={reply.id}
                    comment={reply}
                    isReply
                    canAct={false}
                  />
                ))}
              </div>
            ))}

            {resolved.length > 0 && (
              <details className="resolved-section">
                <summary>
                  {resolved.length} resolved comment
                  {resolved.length !== 1 ? "s" : ""}
                </summary>
                {resolved.map((comment) => (
                  <div key={comment.id} className="comment-thread resolved">
                    <CommentItem
                      comment={comment}
                      onResolve={() => resolveComment(comment.id)}
                      canAct={!!accessToken}
                    />
                  </div>
                ))}
              </details>
            )}
          </div>
        </div>
      )}
    </>
  );
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
      {comment.anchorText && (
        <div className="comment-anchor">
          "{comment.anchorText.slice(0, 80)}
          {comment.anchorText.length > 80 ? "…" : ""}"
        </div>
      )}
      <div className="comment-meta">
        <span className="comment-author">
          {comment.author?.name || "Unknown"}
        </span>
        <span className="comment-date">
          {new Date(comment.createdAt).toLocaleDateString()}
        </span>
      </div>
      <div className="comment-body">{comment.body}</div>
      {canAct && (
        <div className="comment-actions">
          {onReply && (
            <button onClick={onReply} className="comment-action">
              Reply
            </button>
          )}
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
