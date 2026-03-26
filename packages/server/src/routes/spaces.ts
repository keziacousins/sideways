import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { type Database, spaces, sections, spaceMembers, users } from "@sideways/db";
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

  /** List spaces visible to the current user */
  router.get("/", async (c) => {
    const user = c.get("user") as AuthUser | null;

    const all = await db.query.spaces.findMany({
      orderBy: desc(spaces.updatedAt),
    });

    // Filter to spaces the user can see
    const visible = [];
    for (const space of all) {
      if (space.visibility === "public") {
        visible.push(space);
      } else if (user) {
        if (space.visibility === "org") {
          visible.push(space);
        } else if (space.ownerId === user.id) {
          visible.push(space);
        } else {
          // Check membership for shared/private
          const member = await db.query.spaceMembers.findFirst({
            where: (m, { and: a, eq: e }) =>
              a(e(m.spaceId, space.id), e(m.userId, user.id)),
          });
          if (member) visible.push(space);
        }
      }
    }

    return c.json(visible);
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
    const rawSlug = c.req.param("slug");
    // Validate slug — must be URL-safe
    const slug = rawSlug.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (!slug) return c.json({ error: "Invalid space slug" }, 400);

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

  /** Create or update a section */
  router.put("/:spaceSlug/sections/:sectionSlug", async (c) => {
    const space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, c.req.param("spaceSlug")),
    });
    if (!space) return c.json({ error: "Space not found" }, 404);

    const sectionSlug = c.req.param("sectionSlug");
    const body = await c.req.json<{ title?: string; position?: number }>();

    const existing = await db.query.sections.findFirst({
      where: and(eq(sections.spaceId, space.id), eq(sections.slug, sectionSlug)),
    });

    if (existing) {
      const [updated] = await db
        .update(sections)
        .set({
          title: body.title ?? existing.title,
          position: body.position ?? existing.position,
          updatedAt: new Date(),
        })
        .where(eq(sections.id, existing.id))
        .returning();
      return c.json(updated, 200);
    }

    const [section] = await db
      .insert(sections)
      .values({
        spaceId: space.id,
        slug: sectionSlug,
        title: body.title ?? sectionSlug,
        position: body.position ?? 0,
      })
      .returning();
    return c.json(section, 201);
  });

  return router;
}
