import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { type Database, spaces } from "@sideways/db";
import type { Storage } from "@sideways/storage";
import type { AuthUser } from "../middleware/auth.js";
import { canAccessSpace } from "../middleware/visibility.js";
import { diagramStoragePath } from "../lib/typst.js";
import { etagMatches, INERT_CSP } from "../lib/assets.js";

/**
 * Rendered Typst diagrams (see lib/typst.ts), as the `<img>` in a rendered
 * document fetches them through the web app's /d/<space>/<hash>.svg.
 *
 * Read access follows the space. The name is the SHA-256 of what the diagram
 * says, so a URL can't be enumerated short of knowing its source already.
 */


const DIAGRAM_FILE_RE = /^([0-9a-f]{64})\.svg$/;

export function createDiagramRoutes(db: Database, storage: Storage) {
  const router = new Hono();

  router.get("/:space/:file", async (c) => {
    const match = DIAGRAM_FILE_RE.exec(c.req.param("file"));
    if (!match) return c.json({ error: "Not found" }, 404);
    const key = match[1];

    const space = await db.query.spaces.findFirst({ where: eq(spaces.slug, c.req.param("space")) });
    if (!space) return c.json({ error: "Space not found" }, 404);
    const user = c.get("user") as AuthUser | null;
    if (!(await canAccessSpace(db, space.id, space.visibility, space.ownerId, user))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const headers = {
      "Content-Type": "image/svg+xml",
      "Content-Security-Policy": INERT_CSP,
      "X-Content-Type-Options": "nosniff",
      // The bytes behind a name never change, so the reader's browser may keep
      // them; `private` because access is per user.
      "Cache-Control": "private, max-age=31536000, immutable",
      ETag: `"${key}"`,
    };
    if (etagMatches(c.req.header("If-None-Match"), headers.ETag)) {
      return new Response(null, { status: 304, headers });
    }

    try {
      const stored = await storage.download(diagramStoragePath(space.id, key));
      return new Response(stored.body, { headers });
    } catch {
      return c.json({ error: "Diagram not found" }, 404);
    }
  });

  return router;
}
