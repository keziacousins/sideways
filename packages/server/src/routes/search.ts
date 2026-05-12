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

    // Build tsquery: full words + prefix match on last token for as-you-type.
    // Tokens are stripped to [a-zA-Z0-9_] so they cannot inject tsquery
    // operators (which would otherwise allow ! &c. into the expression).
    const tokens = q
      .split(/\s+/)
      .map((w) => w.replace(/[^a-zA-Z0-9_]/g, ""))
      .filter(Boolean);

    if (tokens.length === 0) {
      return c.json({ results: [], total: 0, query: q });
    }

    const tsqueryStr =
      tokens.length === 1
        ? `${tokens[0]}:*`
        : `${tokens.slice(0, -1).join(" & ")} & ${tokens[tokens.length - 1]}:*`;

    // Visibility filter — fully parameterised; no interpolation of user input.
    const visibilityClause = user
      ? sql`(
          s.visibility = 'public'
          OR s.visibility = 'org'
          OR s.owner_id = ${user.id}
          OR EXISTS (
            SELECT 1 FROM space_members sm
            WHERE sm.space_id = s.id AND sm.user_id = ${user.id}
          )
        )`
      : sql`s.visibility = 'public'`;

    const spaceClause = spaceFilter
      ? sql`AND s.slug = ${spaceFilter}`
      : sql``;

    const query = sql`
      SELECT
        s.slug as "spaceSlug",
        s.name as "spaceName",
        d.slug as "docSlug",
        d.title,
        d.tags,
        d.updated_at as "updatedAt",
        ts_rank_cd(d.search_tsv, to_tsquery('english', ${tsqueryStr})) as rank,
        ts_headline(
          'english',
          COALESCE(dv.content, d.title),
          to_tsquery('english', ${tsqueryStr}),
          'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15, MaxFragments=2'
        ) as snippet
      FROM documents d
      JOIN spaces s ON d.space_id = s.id
      LEFT JOIN LATERAL (
        SELECT content FROM document_versions
        WHERE document_id = d.id
        ORDER BY version DESC LIMIT 1
      ) dv ON true
      WHERE d.search_tsv @@ to_tsquery('english', ${tsqueryStr})
        AND ${visibilityClause}
        ${spaceClause}
      ORDER BY rank DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `;

    try {
      const results = await db.execute(query);

      // Count total (without limit/offset)
      const countQuery = sql`
        SELECT COUNT(*) as total
        FROM documents d
        JOIN spaces s ON d.space_id = s.id
        WHERE d.search_tsv @@ to_tsquery('english', ${tsqueryStr})
          AND ${visibilityClause}
          ${spaceClause}
      `;
      const countResult = await db.execute(countQuery);
      const total = parseInt((countResult as any)[0]?.total || "0");

      return c.json({
        results: (results as any[]).map((r) => ({
          ...r,
          rank: parseFloat(r.rank),
        })),
        total,
        query: q,
      });
    } catch {
      // tsquery parse error (shouldn't happen now that tokens are sanitised)
      return c.json({ results: [], total: 0, query: q, error: "Invalid search query" });
    }
  });

  return router;
}
