import { useState, useEffect, useRef } from "react";

interface Notification {
  id: string;
  type: string;
  spaceSlug: string;
  docSlug: string;
  title: string;
  body?: string;
  actorName?: string;
  createdAt: string;
  read: boolean;
}

interface Props {
  apiUrl: string;
  accessToken: string | null;
  refreshToken: string | null;
}

async function authFetch(url: string, apiUrl: string, accessToken: string | null, refreshToken: string | null, opts?: RequestInit) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

  let res = await fetch(`${apiUrl}${url}`, { ...opts, headers });

  if (res.status === 401 && refreshToken) {
    const tokenRes = await fetch(`${apiUrl}/api/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: "sideways-web" }),
    });
    if (tokenRes.ok) {
      const tokens = await tokenRes.json();
      headers["Authorization"] = `Bearer ${tokens.access_token}`;
      res = await fetch(`${apiUrl}${url}`, { ...opts, headers });
    }
  }

  return res;
}

const TYPE_ICONS: Record<string, string> = {
  reply: "↩",
  mention: "@",
  new_comment: "💬",
  doc_updated: "📝",
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function NotificationBell({ apiUrl, accessToken, refreshToken }: Props) {
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Fetch unread count on mount + poll
  useEffect(() => {
    if (!accessToken) return;

    const fetchCount = async () => {
      try {
        const res = await authFetch("/api/notifications/count", apiUrl, accessToken, refreshToken);
        if (res.ok) {
          const data = await res.json();
          setUnreadCount(data.unreadCount);
        }
      } catch {}
    };

    fetchCount();
    const interval = setInterval(fetchCount, 60_000);
    return () => clearInterval(interval);
  }, [accessToken]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const loadNotifications = async () => {
    try {
      const res = await authFetch("/api/notifications?limit=20", apiUrl, accessToken, refreshToken);
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.notifications);
        setUnreadCount(data.unreadCount);
        setLoaded(true);
      }
    } catch {}
  };

  const toggle = () => {
    if (!open && !loaded) loadNotifications();
    setOpen(!open);
  };

  const markAllRead = async () => {
    try {
      await authFetch("/api/notifications/read-all", apiUrl, accessToken, refreshToken, { method: "POST" });
      setUnreadCount(0);
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    } catch {}
  };

  const dismiss = async (id: string) => {
    try {
      await authFetch(`/api/notifications/${id}`, apiUrl, accessToken, refreshToken, { method: "DELETE" });
      setNotifications(prev => prev.filter(n => n.id !== id));
    } catch {}
  };

  if (!accessToken) return null;

  return (
    <div className="notif-bell-wrapper" ref={ref}>
      <button className="notif-bell-btn" onClick={toggle} title="Notifications">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && <span className="notif-badge">{unreadCount > 9 ? "9+" : unreadCount}</span>}
      </button>

      {open && (
        <div className="notif-panel">
          <div className="notif-header">
            <span>Notifications</span>
            {unreadCount > 0 && (
              <button className="notif-mark-read" onClick={markAllRead}>Mark all read</button>
            )}
          </div>
          <div className="notif-list">
            {notifications.length === 0 && (
              <div className="notif-empty">No notifications</div>
            )}
            {notifications.map((n) => (
              <div key={n.id} className={`notif-item ${n.read ? "read" : "unread"}`}>
                <a href={`/s/${n.spaceSlug}/${n.docSlug}`} className="notif-link">
                  <span className="notif-icon">{TYPE_ICONS[n.type] || "•"}</span>
                  <div className="notif-content">
                    <div className="notif-title">{n.title}</div>
                    {n.body && <div className="notif-body">{n.body.slice(0, 100)}{n.body.length > 100 ? "…" : ""}</div>}
                    <div className="notif-meta">{timeAgo(n.createdAt)}</div>
                  </div>
                </a>
                <button className="notif-dismiss" onClick={(e) => { e.stopPropagation(); dismiss(n.id); }} title="Dismiss">×</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
