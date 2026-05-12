import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { type Database } from "@sideways/db";
import type { AuthUser } from "../middleware/auth.js";

export function createSearchRoutes(db: Database) {
  const router = new Hono();

  /**
   * GET /api/search?q=...&space=...&limit=...&offset=...
   * Full-text search across documents with visibility filtering.
   */
  router.get("/", async (c) => {
    const q = c.req.query("q")?.trim();
    if (!q || q.length < 2) {
      return c.json({ results: [], total: 0, query: q || "" });
    }

    const spaceFilter = c.req.query("space");
    const limit = Math.min(parseInt(c.req.query("limit") || "20"), 50);
    const offset = parseInt(c.req.query("offset") || "0");
    const user = c.get("user") as AuthUser | null;

    // Build tsquery: full words + prefix match on last token for as-you-type
    const words = q.split(/\s+/).filter(Boolean);
    let tsqueryStr: string;
    if (words.length === 1) {
      tsqueryStr = `${words[0]}:*`;
    } else {
      const fullWords = words.slice(0, -1).join(" & ");
      const lastWord = words[words.length - 1];
      tsqueryStr = `${fullWords} & ${lastWord}:*`;
    }

    // Build visibility filter
    let visibilityClause: string;
    if (user) {
      visibilityClause = `(
        s.visibility = 'public'
        OR s.visibility = 'org'
        OR s.owner_id = '${user.id}'
        OR EXISTS (
          SELECT 1 FROM space_members sm
          WHERE sm.space_id = s.id AND sm.user_id = '${user.id}'
        )
      )`;
    } else {
      visibilityClause = `s.visibility = 'public'`;
    }

    // Optional space filter
    const spaceClause = spaceFilter
      ? `AND s.slug = '${spaceFilter.replace(/'/g, "''")}'`
      : "";

    const query = sql.raw(`
      SELECT
        s.slug as "spaceSlug",
        s.name as "spaceName",
        d.slug as "docSlug",
        d.title,
        d.tags,
        d.updated_at as "updatedAt",
        ts_rank_cd(d.search_tsv, to_tsquery('english', '${tsqueryStr.replace(/'/g, "''")}')) as rank,
        ts_headline(
          'english',
          COALESCE(dv.content, d.title),
          to_tsquery('english', '${tsqueryStr.replace(/'/g, "''")}'),
          'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15, MaxFragments=2'
        ) as snippet
      FROM documents d
      JOIN spaces s ON d.space_id = s.id
      LEFT JOIN LATERAL (
        SELECT content FROM document_versions
        WHERE document_id = d.id
        ORDER BY version DESC LIMIT 1
      ) dv ON true
      WHERE d.search_tsv @@ to_tsquery('english', '${tsqueryStr.replace(/'/g, "''")}')
        AND ${visibilityClause}
        ${spaceClause}
      ORDER BY rank DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `);

    try {
      const results = await db.execute(query);

      // Count total (without limit/offset)
      const countQuery = sql.raw(`
        SELECT COUNT(*) as total
        FROM documents d
        JOIN spaces s ON d.space_id = s.id
        WHERE d.search_tsv @@ to_tsquery('english', '${tsqueryStr.replace(/'/g, "''")}')
          AND ${visibilityClause}
          ${spaceClause}
      `);
      const countResult = await db.execute(countQuery);
      const total = parseInt((countResult as any)[0]?.total || "0");

      return c.json({
        results: (results as any[]).map(r => ({
          ...r,
          rank: parseFloat(r.rank),
        })),
        total,
        query: q,
      });
    } catch {
      // tsquery parse error (invalid search syntax)
      return c.json({ results: [], total: 0, query: q, error: "Invalid search query" });
    }
  });

  return router;
}
