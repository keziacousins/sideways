import { useState, useEffect, useCallback } from "react";

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
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [newComment, setNewComment] = useState("");
  const [anchorText, setAnchorText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

  // Listen for custom event from the vanilla JS selection handler
  useEffect(() => {
    function handleInlineComment(e: Event) {
      const detail = (e as CustomEvent).detail;
      // Reset form completely for the new selection
      setNewComment("");
      setReplyTo(null);
      setAnchorText(detail.anchorText);
      setIsOpen(true);
    }

    document.addEventListener("sideways:inline-comment", handleInlineComment);
    return () =>
      document.removeEventListener(
        "sideways:inline-comment",
        handleInlineComment,
      );
  }, []);

  const submitComment = async () => {
    if (!newComment.trim()) return;
    setError(null);
    setSubmitting(true);

    const submitHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (accessToken) submitHeaders["Authorization"] = `Bearer ${accessToken}`;

    try {
      const res = await fetch(
        `${apiUrl}/api/comments/${spaceSlug}/${docSlug}`,
        {
          method: "POST",
          headers: submitHeaders,
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
      } else if (res.status === 401) {
        setError("Session expired. Please refresh the page and sign in again.");
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
      {/* Toggle button */}
      <button
        className="comments-toggle"
        onClick={() => setIsOpen(!isOpen)}
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

      {/* Comments panel */}
      {isOpen && (
        <div className="comments-panel-overlay">
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
            <form className="comment-form" onSubmit={(e) => { e.preventDefault(); submitComment(); }}>
              {anchorText && !replyTo && (
                <div className="comment-form-anchor">
                  <span>
                    "{anchorText.slice(0, 60)}
                    {anchorText.length > 60 ? "…" : ""}"
                  </span>
                  <button type="button" onClick={() => setAnchorText(null)}>×</button>
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
              {error && <div className="comment-form-error">{error}</div>}
              <div className="comment-form-actions">
                {(replyTo || anchorText) && (
                  <button
                    type="button"
                    className="comment-form-cancel"
                    onClick={() => {
                      setReplyTo(null);
                      setAnchorText(null);
                      setNewComment("");
                      setError(null);
                    }}
                  >
                    Cancel
                  </button>
                )}
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
