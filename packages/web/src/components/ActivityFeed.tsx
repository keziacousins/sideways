import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import type { SpaceEvent, SpaceEventType } from "@sideways/types";
import { authFetch } from "../lib/session-token.ts";
import { groupActivity, dayLabel, type ActivityRow } from "../lib/activity.ts";
import { icons } from "../lib/icons.ts";

interface Props {
  apiUrl: string;
  accessToken: string | null;
  spaceSlug: string;
}

const TYPE_ICONS: Record<SpaceEventType, string> = {
  doc_created: icons.plus(14),
  doc_edited: icons.edit(14),
  doc_deleted: icons.trash(14),
  doc_renamed: icons.pencil(14),
  doc_moved: icons.arrow(14),
  doc_moved_out: icons.arrow(14),
  doc_moved_in: icons.arrow(14),
  comment_created: icons.comment(14),
};

/** What a burst did, e.g. "created 12 documents" */
function burstText(type: SpaceEventType, count: number): string {
  const docs = `${count} documents`;
  switch (type) {
    case "doc_created": return `created ${docs}`;
    case "doc_deleted": return `deleted ${docs}`;
    case "doc_moved": return `moved ${docs}`;
    case "doc_moved_out": return `moved ${docs} to another space`;
    case "doc_moved_in": return `moved ${docs} here from another space`;
    default: return `edited ${docs}`;
  }
}

function clockTime(event: SpaceEvent): string {
  return new Date(event.createdAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** The document's title, linked while the document is still there to link to */
function DocName({ event }: { event: SpaceEvent }) {
  return event.url ? (
    <a className="activity-doc" href={event.url}>{event.title}</a>
  ) : (
    <span className="activity-doc activity-doc-gone">{event.title}</span>
  );
}

function Count({ row, unit }: { row: ActivityRow; unit: string }) {
  const n = row.events.length;
  return n > 1 ? <span className="activity-count"> · {n} {unit}</span> : null;
}

/** What happened, to follow the actor's name */
function Action({ row }: { row: ActivityRow }) {
  const [event] = row.events;
  const doc = <DocName event={event} />;
  switch (row.type) {
    case "doc_created": return <>created {doc}</>;
    case "doc_edited": return <>edited {doc}<Count row={row} unit="times" /></>;
    case "doc_deleted": return <>deleted {doc}</>;
    case "doc_renamed": return <>renamed <span className="activity-was">{event.detail?.from}</span> to {doc}</>;
    case "doc_moved": return <>moved {doc}</>;
    case "doc_moved_out": return <>moved {doc} to another space</>;
    case "doc_moved_in": return <>moved {doc} here from another space</>;
    case "comment_created": return <>commented on {doc}<Count row={row} unit="comments" /></>;
  }
}

/** The second line some rows carry: where a document moved, or what a comment says */
function Detail({ row }: { row: ActivityRow }) {
  const [event] = row.events;
  if (row.type === "doc_moved" && event.detail) {
    return <div className="activity-detail activity-path">{event.detail.from} → {event.detail.to}</div>;
  }
  if (row.type === "comment_created") {
    const snippet = row.events.find((e) => e.snippet)?.snippet;
    return snippet ? <div className="activity-detail activity-snippet">{snippet}</div> : null;
  }
  return null;
}

function Row({ row, open, onToggle }: { row: ActivityRow; open: boolean; onToggle: () => void }) {
  const [event] = row.events;
  return (
    <li className="activity-row">
      <span className="activity-icon" dangerouslySetInnerHTML={{ __html: TYPE_ICONS[row.type] }} />
      <div className="activity-body">
        <div>
          <span className="activity-actor">{row.actorName}</span>{" "}
          {row.children ? (
            <button className="activity-burst" aria-expanded={open} onClick={onToggle}>
              {burstText(row.type, row.children.length)}
              <span className="activity-chevron" dangerouslySetInnerHTML={{ __html: icons.chevron(11) }} />
            </button>
          ) : (
            <Action row={row} />
          )}
        </div>
        {row.children ? (
          open && (
            <ul className="activity-children">
              {row.children.map((child) => (
                <li key={child.key}>
                  <span>
                    <DocName event={child.events[0]} />
                    <Count row={child} unit="times" />
                  </span>
                  <span className="activity-time">{clockTime(child.events[0])}</span>
                </li>
              ))}
            </ul>
          )
        ) : (
          <Detail row={row} />
        )}
      </div>
      <time className="activity-time" dateTime={event.createdAt} title={new Date(event.createdAt).toLocaleString()}>
        {clockTime(event)}
      </time>
    </li>
  );
}

export default function ActivityFeed({ apiUrl, accessToken, spaceSlug }: Props) {
  const tokenRef = useRef(accessToken);
  const [events, setEvents] = useState<SpaceEvent[]>([]);
  // Where the next page starts; null once the whole log is loaded
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());

  const load = useCallback(async (before: string | null) => {
    setStatus("loading");
    try {
      const res = await authFetch(
        `/api/spaces/${encodeURIComponent(spaceSlug)}/activity${before ? `?before=${before}` : ""}`,
        apiUrl,
        tokenRef,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: { events: SpaceEvent[]; nextCursor: string | null } = await res.json();
      setEvents((prev) => (before ? [...prev, ...data.events] : data.events));
      setCursor(data.nextCursor);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [apiUrl, spaceSlug]);

  useEffect(() => {
    load(null);
  }, [load]);

  // Folded here rather than on the server: the day an event falls on is the viewer's
  const days = useMemo(() => groupActivity(events), [events]);

  const toggle = (key: string) => {
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  return (
    <div className="activity-feed">
      {days.map((day) => (
        <section key={day.date.getTime()} className="activity-day">
          <h2 className="activity-day-label">{dayLabel(day.date)}</h2>
          <ul className="activity-list">
            {day.rows.map((row) => (
              <Row key={row.key} row={row} open={openRows.has(row.key)} onToggle={() => toggle(row.key)} />
            ))}
          </ul>
        </section>
      ))}

      {events.length === 0 && status !== "error" && (
        <p className="activity-empty">{status === "loading" ? "Loading…" : "No activity in this space yet."}</p>
      )}
      {status === "error" && (
        <p className="activity-empty">
          Couldn't load activity.{" "}
          <button className="activity-retry" onClick={() => load(cursor)}>Try again</button>
        </p>
      )}
      {cursor && status !== "error" && (
        <button className="activity-more" disabled={status === "loading"} onClick={() => load(cursor)}>
          {status === "loading" ? "Loading…" : "Show older"}
        </button>
      )}
    </div>
  );
}
