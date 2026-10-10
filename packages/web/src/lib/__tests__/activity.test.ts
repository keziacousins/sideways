import { describe, it, expect } from "vitest";
import type { SpaceEvent, SpaceEventType } from "@sideways/types";
import { groupActivity, dayLabel } from "../activity.js";

/**
 * Times are built in local time, as the code under test reads them, so these
 * hold in whatever timezone the suite runs in.
 */
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 9, day, hour, minute).toISOString();

let nextId = 0;

function event(
  type: SpaceEventType,
  doc: string,
  createdAt: string,
  over: Partial<SpaceEvent> = {},
): SpaceEvent {
  return {
    id: `e${++nextId}`,
    type,
    actorId: "u1",
    actorName: "Kezia",
    documentId: doc,
    title: doc,
    url: `/s/space/default/${doc}`,
    detail: null,
    snippet: null,
    createdAt,
    ...over,
  };
}

/** The API returns events newest first; tests list them in the order they happened. */
const feed = (...events: SpaceEvent[]) =>
  groupActivity([...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));

const summary = (events: SpaceEvent[]) =>
  groupActivity(events).flatMap((day) =>
    day.rows.map((row) => `${row.type}:${row.events[0].title}x${row.events.length}`),
  );

describe("groupActivity", () => {
  it("returns nothing for an empty log", () => {
    expect(groupActivity([])).toEqual([]);
  });

  it("puts events under the local day they fell on, newest day first", () => {
    const days = feed(
      event("doc_created", "a", at(8, 23, 50)),
      event("doc_created", "b", at(9, 0, 10)),
      event("doc_created", "c", at(9, 14)),
    );
    expect(days.map((d) => d.date)).toEqual([new Date(2026, 9, 9), new Date(2026, 9, 8)]);
    expect(days[0].rows.map((r) => r.events[0].title)).toEqual(["c", "b"]);
    expect(days[1].rows.map((r) => r.events[0].title)).toEqual(["a"]);
  });

  describe("repeats on one document", () => {
    it("folds a day's edits by one actor into one row, timed by the newest", () => {
      const [day] = feed(
        event("doc_edited", "a", at(9, 9)),
        event("doc_edited", "a", at(9, 11)),
        event("doc_edited", "a", at(9, 16)),
      );
      expect(day.rows).toHaveLength(1);
      expect(day.rows[0].events.map((e) => e.createdAt)).toEqual([at(9, 16), at(9, 11), at(9, 9)]);
      expect(day.rows[0].children).toBeUndefined();
    });

    it("folds edits that other events fall between", () => {
      const [day] = feed(
        event("doc_edited", "a", at(9, 9)),
        event("doc_created", "b", at(9, 10)),
        event("doc_edited", "a", at(9, 11)),
      );
      expect(day.rows.map((r) => `${r.type}:${r.events.length}`)).toEqual([
        "doc_edited:2",
        "doc_created:1",
      ]);
    });

    it("does not fold across days", () => {
      const days = feed(event("doc_edited", "a", at(8, 9)), event("doc_edited", "a", at(9, 9)));
      expect(days.map((d) => d.rows.length)).toEqual([1, 1]);
    });

    it("does not fold different actors, nor an agent with the person whose key it uses", () => {
      const [day] = feed(
        event("doc_edited", "a", at(9, 9)),
        event("doc_edited", "a", at(9, 10), { actorId: "u2", actorName: "Sam" }),
        event("doc_edited", "a", at(9, 11), { actorName: "Scribe via Kezia" }),
      );
      expect(day.rows.map((r) => r.actorName)).toEqual(["Scribe via Kezia", "Sam", "Kezia"]);
    });

    it("folds comments, keeping each one's snippet", () => {
      const [day] = feed(
        event("comment_created", "a", at(9, 9), { snippet: "first" }),
        event("comment_created", "a", at(9, 10), { snippet: "second" }),
      );
      expect(day.rows).toHaveLength(1);
      expect(day.rows[0].events.map((e) => e.snippet)).toEqual(["second", "first"]);
    });

    it("keeps each rename and move as its own row", () => {
      const [day] = feed(
        event("doc_renamed", "a", at(9, 9), { detail: { from: "A", to: "B" } }),
        event("doc_renamed", "a", at(9, 10), { detail: { from: "B", to: "C" } }),
        event("doc_moved", "a", at(9, 11)),
        event("doc_moved", "a", at(9, 12)),
      );
      expect(day.rows).toHaveLength(4);
    });

    it("still folds a deleted document's edits", () => {
      const [day] = feed(
        event("doc_edited", "a", at(9, 9), { url: null }),
        event("doc_edited", "a", at(9, 10), { url: null }),
        event("doc_deleted", "a", at(9, 11), { url: null }),
      );
      expect(day.rows.map((r) => `${r.type}:${r.events.length}`)).toEqual([
        "doc_deleted:1",
        "doc_edited:2",
      ]);
    });
  });

  describe("bursts across documents", () => {
    it("folds a quick run over four documents into one row with a child per document", () => {
      const [day] = feed(
        event("doc_created", "a", at(9, 9, 0)),
        event("doc_created", "b", at(9, 9, 1)),
        event("doc_created", "c", at(9, 9, 2)),
        event("doc_created", "d", at(9, 9, 3)),
      );
      expect(day.rows).toHaveLength(1);
      expect(day.rows[0].events).toHaveLength(4);
      expect(day.rows[0].children!.map((c) => c.events[0].title)).toEqual(["d", "c", "b", "a"]);
    });

    it("leaves three documents as separate rows", () => {
      const [day] = feed(
        event("doc_created", "a", at(9, 9, 0)),
        event("doc_created", "b", at(9, 9, 1)),
        event("doc_created", "c", at(9, 9, 2)),
      );
      expect(day.rows).toHaveLength(3);
    });

    it("chains a run through pauses of up to five minutes, and breaks it on a longer one", () => {
      const chained = feed(
        event("doc_created", "a", at(9, 9, 0)),
        event("doc_created", "b", at(9, 9, 5)),
        event("doc_created", "c", at(9, 9, 10)),
        event("doc_created", "d", at(9, 9, 15)),
      );
      expect(chained[0].rows).toHaveLength(1);

      const broken = feed(
        event("doc_created", "a", at(9, 9, 0)),
        event("doc_created", "b", at(9, 9, 1)),
        event("doc_created", "c", at(9, 9, 7)),
        event("doc_created", "d", at(9, 9, 8)),
      );
      expect(broken[0].rows).toHaveLength(4);
    });

    it("counts documents, not events: many saves of one document are not a burst", () => {
      const [day] = feed(
        ...[0, 1, 2, 3, 4, 5].map((m) => event("doc_edited", "a", at(9, 9, m))),
        event("doc_edited", "b", at(9, 9, 6)),
      );
      expect(day.rows.map((r) => `${r.events[0].title}:${r.events.length}`)).toEqual(["b:1", "a:6"]);
      expect(day.rows.every((r) => !r.children)).toBe(true);
    });

    it("folds repeat saves inside a burst into the document's child row", () => {
      const [day] = feed(
        event("doc_edited", "a", at(9, 9, 0)),
        event("doc_edited", "b", at(9, 9, 1)),
        event("doc_edited", "c", at(9, 9, 2)),
        event("doc_edited", "d", at(9, 9, 3)),
        event("doc_edited", "a", at(9, 9, 4)),
      );
      expect(day.rows).toHaveLength(1);
      expect(day.rows[0].children!.map((c) => `${c.events[0].title}:${c.events.length}`)).toEqual([
        "a:2",
        "d:1",
        "c:1",
        "b:1",
      ]);
    });

    it("splits a sync that both creates and edits into a burst of each", () => {
      const docs = ["a", "b", "c", "d"];
      const [day] = feed(
        ...docs.map((d, i) => event("doc_created", d, at(9, 9, i))),
        ...docs.map((d, i) => event("doc_edited", `old-${d}`, at(9, 9, i))),
      );
      expect(day.rows.map((r) => `${r.type}:${r.children?.length}`).sort()).toEqual([
        "doc_created:4",
        "doc_edited:4",
      ]);
    });

    it("keeps a later edit apart from the morning's burst", () => {
      const [day] = feed(
        event("doc_edited", "a", at(9, 9, 0)),
        event("doc_edited", "b", at(9, 9, 1)),
        event("doc_edited", "c", at(9, 9, 2)),
        event("doc_edited", "d", at(9, 9, 3)),
        event("doc_edited", "a", at(9, 15)),
      );
      expect(day.rows.map((r) => `${r.events[0].title}:${r.children?.length ?? "-"}`)).toEqual([
        "a:-",
        "d:4",
      ]);
    });

    it("never bursts comments or renames", () => {
      const docs = ["a", "b", "c", "d"];
      expect(summary(docs.map((d, i) => event("comment_created", d, at(9, 9, 9 - i))))).toHaveLength(4);
      expect(summary(docs.map((d, i) => event("doc_renamed", d, at(9, 9, 9 - i))))).toHaveLength(4);
    });
  });
});

describe("dayLabel", () => {
  const now = new Date(2026, 9, 10, 15, 30);

  it("names today and yesterday", () => {
    expect(dayLabel(new Date(2026, 9, 10), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 9), now)).toBe("Yesterday");
  });

  it("names yesterday across a month boundary", () => {
    expect(dayLabel(new Date(2026, 8, 30), new Date(2026, 9, 1, 0, 5))).toBe("Yesterday");
  });

  it("gives older days a date, with the year only when it differs", () => {
    expect(dayLabel(new Date(2026, 9, 5), now)).toMatch(/5/);
    expect(dayLabel(new Date(2026, 9, 5), now)).not.toMatch(/2026/);
    expect(dayLabel(new Date(2025, 11, 31), now)).toMatch(/2025/);
  });
});
