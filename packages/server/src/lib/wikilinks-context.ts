/**
 * Build a `WikiLinkContext` for a space — fetches the doc list and section
 * list once per render so the wikilink resolver can do its lookups.
 *
 * Hot path: every doc render hits this. Currently a full scan of docs in
 * the space; fine at typical scale (<1000 docs/space). Index later if it
 * shows up in profiles.
 */

import { eq } from "drizzle-orm";
import { type Database, documents, sections } from "@sideways/db";
import type { WikiLinkContext } from "@sideways/markdown";

export async function loadWikiLinkContext(
  db: Database,
  spaceId: string,
  spaceSlug: string,
  from?: { sectionSlug: string; path: string },
): Promise<WikiLinkContext> {
  const [docRows, sectionRows] = await Promise.all([
    db
      .select({
        path: documents.path,
        title: documents.title,
        sectionSlug: sections.slug,
      })
      .from(documents)
      .innerJoin(sections, eq(documents.sectionId, sections.id))
      .where(eq(documents.spaceId, spaceId)),
    db
      .select({ slug: sections.slug, id: sections.id })
      .from(sections)
      .where(eq(sections.spaceId, spaceId)),
  ]);

  // A section "has an index" iff there's a doc at path "index.md" in it.
  const indexDocSections = new Set(
    docRows
      .filter((d) => d.path === "index.md")
      .map((d) => d.sectionSlug),
  );

  return {
    spaceSlug,
    docs: docRows.map((d) => ({
      sectionSlug: d.sectionSlug,
      path: d.path,
      title: d.title,
    })),
    sections: sectionRows.map((s) => ({
      slug: s.slug,
      hasIndex: indexDocSections.has(s.slug),
    })),
    from,
  };
}
