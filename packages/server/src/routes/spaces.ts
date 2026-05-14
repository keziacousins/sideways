import { Hono } from "hono";
import { eq, and, desc, sql } from "drizzle-orm";
import { type Database, spaces, sections, documents, spaceMembers, spaceWatches, themes, users } from "@sideways/db";
import type { AuthUser } from "../middleware/auth.js";
import { canAccessSpace, canWriteSpace } from "../middleware/visibility.js";
import { autoWatchSpace } from "../lib/notify.js";

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

    const user = c.get("user") as AuthUser | null;
    const canWrite = await canWriteSpace(db, space.id, space.ownerId, user);

    // Include theme tokens if space has a theme
    let theme: { id: string; name: string; tokens: any } | null = null;
    if (space.themeId) {
      const t = await db.query.themes.findFirst({
        where: eq(themes.id, space.themeId),
      });
      if (t) theme = { id: t.id, name: t.name, tokens: t.tokens };
    }

    return c.json({ ...space, canWrite, theme });
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
      themeId?: string | null;
    }>();

    const ownerId = await getUserId(c, db);

    const existing = await db.query.spaces.findFirst({
      where: eq(spaces.slug, slug),
    });

    if (existing) {
      // Only owner can change visibility
      if (body.visibility && body.visibility !== existing.visibility && existing.ownerId !== ownerId) {
        return c.json({ error: "Only the space owner can change visibility" }, 403);
      }
      // Must have write access to update
      const user = c.get("user") as AuthUser | null;
      if (!await canWriteSpace(db, existing.id, existing.ownerId, user)) {
        return c.json({ error: "You don't have permission to update this space" }, 403);
      }
      const [updated] = await db
        .update(spaces)
        .set({
          name: body.name ?? existing.name,
          description: body.description ?? existing.description,
          visibility: body.visibility ?? existing.visibility,
          themeId: body.themeId !== undefined ? body.themeId : existing.themeId,
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

    // Every space has a `default` section as a server-side invariant.
    await db.insert(sections).values({
      spaceId: space.id,
      slug: "default",
      title: "Default",
      position: 0,
    });

    // Auto-watch the space for the creator
    autoWatchSpace(db, ownerId, space.id).catch(() => {});

    return c.json(space, 201);
  });

  /** Delete a space and all its documents — owner only */
  router.delete("/:slug", async (c) => {
    const space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, c.req.param("slug")),
    });
    if (!space) return c.json({ error: "Not found" }, 404);

    const user = c.get("user") as AuthUser | null;
    if (!user || space.ownerId !== user.id) {
      return c.json({ error: "Only the space owner can delete a space" }, 403);
    }

    // Cascade: documents, versions, comments are handled by FK ON DELETE CASCADE
    await db.delete(spaces).where(eq(spaces.id, space.id));
    return c.json({ deleted: true });
  });

  /** List sections in a space — requires read access */
  router.get("/:slug/sections", async (c) => {
    const space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, c.req.param("slug")),
    });
    if (!space) return c.json({ error: "Space not found" }, 404);

    const user = c.get("user") as AuthUser | null;
    if (!await canAccessSpace(db, space.id, space.visibility, space.ownerId, user)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const all = await db.query.sections.findMany({
      where: eq(sections.spaceId, space.id),
    });
    return c.json(all);
  });

  /** Create or update a section — requires write access */
  router.put("/:spaceSlug/sections/:sectionSlug", async (c) => {
    const space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, c.req.param("spaceSlug")),
    });
    if (!space) return c.json({ error: "Space not found" }, 404);

    const user = c.get("user") as AuthUser | null;
    if (!await canWriteSpace(db, space.id, space.ownerId, user)) {
      return c.json({ error: "Forbidden" }, 403);
    }

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

    // `default` is a reserved slug — created automatically on space creation.
    if (sectionSlug === "default") {
      return c.json({ error: "`default` is a reserved section slug" }, 400);
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

  /**
   * Delete a section. Refuses if the section still has documents — caller
   * must `/empty` it first. The `default` section is permanent and cannot
   * be deleted under any circumstance.
   */
  router.delete("/:spaceSlug/sections/:sectionSlug", async (c) => {
    const space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, c.req.param("spaceSlug")),
    });
    if (!space) return c.json({ error: "Space not found" }, 404);

    const user = c.get("user") as AuthUser | null;
    if (!await canWriteSpace(db, space.id, space.ownerId, user)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const sectionSlug = c.req.param("sectionSlug");
    if (sectionSlug === "default") {
      return c.json({ error: "The `default` section is permanent" }, 400);
    }

    const section = await db.query.sections.findFirst({
      where: and(eq(sections.spaceId, space.id), eq(sections.slug, sectionSlug)),
    });
    if (!section) return c.json({ error: "Section not found" }, 404);

    const [{ count: docCount }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(documents)
      .where(eq(documents.sectionId, section.id));

    if (docCount > 0) {
      return c.json(
        {
          error: `Section is not empty (${docCount} document${docCount === 1 ? "" : "s"}). POST .../empty first to move them to the default section.`,
        },
        409,
      );
    }

    await db.delete(sections).where(eq(sections.id, section.id));
    return c.json({ deleted: true });
  });

  /**
   * Move every document in a section into the space's `default` section.
   * Separate from delete: emptying is a content move; delete is metadata.
   */
  router.post("/:spaceSlug/sections/:sectionSlug/empty", async (c) => {
    const space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, c.req.param("spaceSlug")),
    });
    if (!space) return c.json({ error: "Space not found" }, 404);

    const user = c.get("user") as AuthUser | null;
    if (!await canWriteSpace(db, space.id, space.ownerId, user)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const sectionSlug = c.req.param("sectionSlug");
    if (sectionSlug === "default") {
      return c.json({ error: "Cannot empty the `default` section into itself" }, 400);
    }

    const section = await db.query.sections.findFirst({
      where: and(eq(sections.spaceId, space.id), eq(sections.slug, sectionSlug)),
    });
    if (!section) return c.json({ error: "Section not found" }, 404);

    const defaultSection = await db.query.sections.findFirst({
      where: and(eq(sections.spaceId, space.id), eq(sections.slug, "default")),
    });
    if (!defaultSection) {
      return c.json({ error: "Space is missing its default section (data error)" }, 500);
    }

    const moved = await db
      .update(documents)
      .set({ sectionId: defaultSection.id, updatedAt: new Date() })
      .where(eq(documents.sectionId, section.id))
      .returning({ id: documents.id });

    return c.json({ moved: moved.length });
  });

  /** List members of a space */
  router.get("/:slug/members", async (c) => {
    const space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, c.req.param("slug")),
    });
    if (!space) return c.json({ error: "Space not found" }, 404);

    const members = await db.query.spaceMembers.findMany({
      where: eq(spaceMembers.spaceId, space.id),
    });

    // Fetch user info for each member
    const memberIds = members.map((m) => m.userId);
    const memberUsers = memberIds.length
      ? await db.query.users.findMany({
          where: (u, { inArray }) => inArray(u.id, memberIds),
          columns: { id: true, name: true, email: true },
        })
      : [];
    const userMap = new Map(memberUsers.map((u) => [u.id, u]));

    // Include owner
    const owner = await db.query.users.findFirst({
      where: eq(users.id, space.ownerId),
      columns: { id: true, name: true, email: true },
    });

    const result = [
      ...(owner ? [{ ...owner, role: "owner" }] : []),
      ...members.map((m) => ({
        ...userMap.get(m.userId),
        role: m.role,
        memberId: m.id,
      })),
    ];

    return c.json(result);
  });

  /** Add or update a space member */
  router.put("/:slug/members", async (c) => {
    const user = c.get("user") as AuthUser | null;
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, c.req.param("slug")),
    });
    if (!space) return c.json({ error: "Space not found" }, 404);

    // Only owner can manage members
    if (space.ownerId !== user.id) {
      return c.json({ error: "Only the space owner can manage members" }, 403);
    }

    const body = await c.req.json<{
      email: string;
      role: "viewer" | "editor" | "admin";
    }>();

    // Find user by email
    const targetUser = await db.query.users.findFirst({
      where: eq(users.email, body.email),
    });
    if (!targetUser) return c.json({ error: "User not found" }, 404);
    if (targetUser.id === space.ownerId) return c.json({ error: "Cannot add owner as member" }, 400);

    // Upsert member
    const existing = await db.query.spaceMembers.findFirst({
      where: and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, targetUser.id)),
    });

    if (existing) {
      const [updated] = await db
        .update(spaceMembers)
        .set({ role: body.role })
        .where(eq(spaceMembers.id, existing.id))
        .returning();
      return c.json({ ...updated, name: targetUser.name, email: targetUser.email });
    }

    const [member] = await db
      .insert(spaceMembers)
      .values({
        spaceId: space.id,
        userId: targetUser.id,
        role: body.role,
      })
      .returning();
    return c.json({ ...member, name: targetUser.name, email: targetUser.email }, 201);
  });

  /** Remove a space member */
  router.delete("/:slug/members/:memberId", async (c) => {
    const user = c.get("user") as AuthUser | null;
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, c.req.param("slug")),
    });
    if (!space) return c.json({ error: "Space not found" }, 404);

    if (space.ownerId !== user.id) {
      return c.json({ error: "Only the space owner can manage members" }, 403);
    }

    await db.delete(spaceMembers).where(eq(spaceMembers.id, c.req.param("memberId")));
    return c.json({ deleted: true });
  });

  /** Toggle space watch */
  router.post("/:slug/watch", async (c) => {
    const user = c.get("user") as AuthUser | null;
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, c.req.param("slug")),
    });
    if (!space) return c.json({ error: "Not found" }, 404);

    const existing = await db.query.spaceWatches.findFirst({
      where: and(eq(spaceWatches.userId, user.id), eq(spaceWatches.spaceId, space.id)),
    });

    if (existing) {
      await db.delete(spaceWatches).where(
        and(eq(spaceWatches.userId, user.id), eq(spaceWatches.spaceId, space.id)),
      );
      return c.json({ watching: false });
    }

    await db.insert(spaceWatches).values({ userId: user.id, spaceId: space.id });
    return c.json({ watching: true });
  });

  /** Check space watch status */
  router.get("/:slug/watch", async (c) => {
    const user = c.get("user") as AuthUser | null;
    if (!user) return c.json({ watching: false });

    const space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, c.req.param("slug")),
    });
    if (!space) return c.json({ error: "Not found" }, 404);

    const existing = await db.query.spaceWatches.findFirst({
      where: and(eq(spaceWatches.userId, user.id), eq(spaceWatches.spaceId, space.id)),
    });
    return c.json({ watching: !!existing });
  });

  return router;
}
