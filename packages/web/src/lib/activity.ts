/**
 * Turns a space's raw activity events into the rows the feed shows.
 *
 * This runs in the browser rather than on the server because which day an
 * event falls on — and so which events count as "the same day" — depends on
 * the viewer's timezone.
 */

import type { SpaceEvent, SpaceEventType } from "@sideways/types";

export interface ActivityRow {
  /** Id of the row's newest event. Stable as older pages are appended. */
  key: string;
  type: SpaceEventType;
  actorName: string;
  /** Every event behind the row, newest first. The first supplies its time, title and link. */
  events: SpaceEvent[];
  /** Set on a burst across many documents: one row per document. */
  children?: ActivityRow[];
}

export interface ActivityDay {
  /** Local midnight at the start of the day */
  date: Date;
  rows: ActivityRow[];
}

/** Repeats of these on one document, by one actor in one day, fold into a single row. */
const FOLDED: ReadonlySet<SpaceEventType> = new Set(["doc_edited", "comment_created"]);

/** A run of these by one actor across enough documents — a sync, say — becomes one row. */
const BURST: ReadonlySet<SpaceEventType> = new Set([
  "doc_created",
  "doc_edited",
  "doc_deleted",
  "doc_moved",
  "doc_moved_out",
  "doc_moved_in",
]);
export const BURST_MIN_DOCS = 4;
/** Longest pause between two events of the same burst */
export const BURST_GAP_MS = 5 * 60_000;

const time = (e: SpaceEvent) => new Date(e.createdAt).getTime();
const docKey = (e: SpaceEvent) => e.documentId ?? e.id;

function toRow(events: SpaceEvent[], children?: ActivityRow[]): ActivityRow {
  const [newest] = events;
  return { key: newest.id, type: newest.type, actorName: newest.actorName, events, children };
}

/** One row per document, or per event where `fold` is off. Events arrive newest first. */
function byDocument(events: SpaceEvent[], fold: boolean): ActivityRow[] {
  const perDoc = new Map<string, SpaceEvent[]>();
  for (const e of events) {
    const key = fold ? docKey(e) : e.id;
    const seen = perDoc.get(key);
    if (seen) seen.push(e);
    else perDoc.set(key, [e]);
  }
  return [...perDoc.values()].map((group) => toRow(group));
}

/** Split events (newest first) wherever the pause between neighbours is too long. */
function splitRuns(events: SpaceEvent[]): SpaceEvent[][] {
  const runs: SpaceEvent[][] = [];
  for (const e of events) {
    const run = runs[runs.length - 1];
    if (run && time(run[run.length - 1]) - time(e) <= BURST_GAP_MS) run.push(e);
    else runs.push([e]);
  }
  return runs;
}

function rowsForDay(events: SpaceEvent[]): ActivityRow[] {
  const groups = new Map<string, SpaceEvent[]>();
  for (const e of events) {
    // An agent acting through someone's key is a different actor from that person
    const key = `${e.type}|${e.actorId ?? ""}|${e.actorName}`;
    const group = groups.get(key);
    if (group) group.push(e);
    else groups.set(key, [e]);
  }

  const rows: ActivityRow[] = [];
  for (const group of groups.values()) {
    const { type } = group[0];
    const loose: SpaceEvent[] = [];
    for (const run of BURST.has(type) ? splitRuns(group) : [group]) {
      const children = byDocument(run, true);
      if (BURST.has(type) && children.length >= BURST_MIN_DOCS) rows.push(toRow(run, children));
      else loose.push(...run);
    }
    rows.push(...byDocument(loose, FOLDED.has(type)));
  }
  return rows.sort((a, b) => time(b.events[0]) - time(a.events[0]));
}

/** Group events (newest first) under the local day they fell on, folded into feed rows. */
export function groupActivity(events: SpaceEvent[]): ActivityDay[] {
  const days: { date: Date; events: SpaceEvent[] }[] = [];
  for (const e of events) {
    const at = new Date(e.createdAt);
    const date = new Date(at.getFullYear(), at.getMonth(), at.getDate());
    const day = days[days.length - 1];
    if (day && day.date.getTime() === date.getTime()) day.events.push(e);
    else days.push({ date, events: [e] });
  }
  return days.map((day) => ({ date: day.date, rows: rowsForDay(day.events) }));
}

/** "Today", "Yesterday", or the date — with its year once that isn't this one. */
export function dayLabel(date: Date, now = new Date()): string {
  const daysAgo = (offset: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset).getTime();
  if (date.getTime() === daysAgo(0)) return "Today";
  if (date.getTime() === daysAgo(1)) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}
