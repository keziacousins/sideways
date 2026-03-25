import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import { type Database, spaces, sections, users } from "@sideways/db";
import type { AuthUser } from "../middleware/auth.js";

async function ensureSystemUser(db: Database): Promise<string> {
  const existing = await db.query.users.findFirst({
    where: eq(users.email, "system@sideways.local"),
  });
  if (existing) return existing.id;

  const [user] = await db
    .insert(users)
    .values({ email: "system@sideways.local", name: "System" })
    .returning();
  return user.id;
}

async function getUserId(c: any, db: Database): Promise<string> {
  const user = c.get("user") as AuthUser | null;
  if (user) return user.id;
  return ensureSystemUser(db);
}

export function createSpaceRoutes(db: Database) {
  const router = new Hono();

  /** List all spaces */
  router.get("/", async (c) => {
    const all = await db.query.spaces.findMany({
      orderBy: desc(spaces.updatedAt),
    });
    return c.json(all);
  });

  /** Get a space by slug */
  router.get("/:slug", async (c) => {
    const space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, c.req.param("slug")),
    });
    if (!space) return c.json({ error: "Not found" }, 404);
    return c.json(space);
  });

  /** Create or update a space */
  router.put("/:slug", async (c) => {
    const slug = c.req.param("slug");
    const body = await c.req.json<{
      name?: string;
      description?: string;
      visibility?: "private" | "shared" | "org" | "public";
      personal?: boolean;
    }>();

    const ownerId = await getUserId(c, db);

    const existing = await db.query.spaces.findFirst({
      where: eq(spaces.slug, slug),
    });

    if (existing) {
      const [updated] = await db
        .update(spaces)
        .set({
          name: body.name ?? existing.name,
          description: body.description ?? existing.description,
          visibility: body.visibility ?? existing.visibility,
          updatedAt: new Date(),
        })
        .where(eq(spaces.id, existing.id))
        .returning();
      return c.json(updated, 200);
    }

    const [space] = await db
      .insert(spaces)
      .values({
        slug,
        name: body.name ?? slug,
        description: body.description ?? null,
        visibility: body.visibility ?? "private",
        ownerId,
        personal: body.personal ?? false,
      })
      .returning();

    return c.json(space, 201);
  });

  /** List sections in a space */
  router.get("/:slug/sections", async (c) => {
    const space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, c.req.param("slug")),
    });
    if (!space) return c.json({ error: "Space not found" }, 404);

    const all = await db.query.sections.findMany({
      where: eq(sections.spaceId, space.id),
    });
    return c.json(all);
  });

  return router;
}
