import { Hono } from "hono";
import { eq, and, isNull } from "drizzle-orm";
import { type Database, spaces, shareLinks, spaceMembers, users } from "@sideways/db";
import type { AuthUser } from "../middleware/auth.js";
import crypto from "node:crypto";

function generateToken(): string {
  return crypto.randomBytes(18).toString("base64url");
}

/**
 * Share link management routes — mounted at /api/spaces (adds /:slug/share paths)
 */
export function createShareRoutes(db: Database) {
  const router = new Hono();

  /** Create a share link — owner only */
  router.post("/:slug/share", async (c) => {
    const user = c.get("user") as AuthUser | null;
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, c.req.param("slug")),
    });
    if (!space) return c.json({ error: "Space not found" }, 404);
    if (space.ownerId !== user.id) {
      return c.json({ error: "Only the space owner can create share links" }, 403);
    }

    const body = await c.req.json<{
      role?: "viewer" | "editor" | "admin";
      expiresInDays?: number;
    }>();

    const role = body.role || "viewer";
    const expiresInDays = body.expiresInDays || 7;
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

    const [link] = await db
      .insert(shareLinks)
      .values({
        token: generateToken(),
        spaceId: space.id,
        role,
        createdBy: user.id,
        expiresAt,
      })
      .returning();

    return c.json(link, 201);
  });

  /** List active (unclaimed, unexpired) share links — owner only */
  router.get("/:slug/share", async (c) => {
    const user = c.get("user") as AuthUser | null;
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, c.req.param("slug")),
    });
    if (!space) return c.json({ error: "Space not found" }, 404);
    if (space.ownerId !== user.id) {
      return c.json({ error: "Only the space owner can view share links" }, 403);
    }

    const links = await db.query.shareLinks.findMany({
      where: and(
        eq(shareLinks.spaceId, space.id),
        isNull(shareLinks.claimedBy),
      ),
    });

    // Filter out expired
    const now = new Date();
    const active = links.filter((l) => l.expiresAt > now);

    return c.json(active);
  });

  /** Revoke an unclaimed share link — owner only */
  router.delete("/:slug/share/:linkId", async (c) => {
    const user = c.get("user") as AuthUser | null;
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const space = await db.query.spaces.findFirst({
      where: eq(spaces.slug, c.req.param("slug")),
    });
    if (!space) return c.json({ error: "Space not found" }, 404);
    if (space.ownerId !== user.id) {
      return c.json({ error: "Only the space owner can revoke share links" }, 403);
    }

    const linkId = c.req.param("linkId");
    const link = await db.query.shareLinks.findFirst({
      where: and(eq(shareLinks.id, linkId), eq(shareLinks.spaceId, space.id)),
    });
    if (!link) return c.json({ error: "Link not found" }, 404);
    if (link.claimedBy) return c.json({ error: "Link already claimed" }, 400);

    await db.delete(shareLinks).where(eq(shareLinks.id, linkId));
    return c.json({ deleted: true });
  });

  return router;
}

/**
 * Invite routes — mounted at /api/invite
 * Public GET for metadata, authenticated POST to claim.
 */
export function createInviteRoutes(db: Database) {
  const router = new Hono();

  /** Get invite metadata — public, no content leak */
  router.get("/:token", async (c) => {
    const link = await db.query.shareLinks.findFirst({
      where: eq(shareLinks.token, c.req.param("token")),
    });

    if (!link) return c.json({ error: "Invite not found" }, 404);

    const now = new Date();
    if (link.expiresAt < now) return c.json({ error: "Invite expired" }, 410);
    if (link.claimedBy) return c.json({ error: "Invite already claimed" }, 410);

    // Fetch space name and inviter name
    const [space, inviter] = await Promise.all([
      db.query.spaces.findFirst({ where: eq(spaces.id, link.spaceId), columns: { name: true, slug: true } }),
      db.query.users.findFirst({ where: eq(users.id, link.createdBy), columns: { name: true } }),
    ]);

    return c.json({
      spaceName: space?.name || "Unknown space",
      spaceSlug: space?.slug,
      inviterName: inviter?.name || "Someone",
      role: link.role,
    });
  });

  /** Claim an invite — requires authentication */
  router.post("/:token", async (c) => {
    const user = c.get("user") as AuthUser | null;
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const link = await db.query.shareLinks.findFirst({
      where: eq(shareLinks.token, c.req.param("token")),
    });

    if (!link) return c.json({ error: "Invite not found" }, 404);

    const now = new Date();
    if (link.expiresAt < now) return c.json({ error: "Invite expired" }, 410);
    if (link.claimedBy) return c.json({ error: "Invite already claimed" }, 410);

    // Check if user is already a member or owner
    const space = await db.query.spaces.findFirst({
      where: eq(spaces.id, link.spaceId),
    });
    if (!space) return c.json({ error: "Space no longer exists" }, 404);

    if (space.ownerId === user.id) {
      return c.json({ error: "You own this space", spaceSlug: space.slug }, 400);
    }

    const existingMember = await db.query.spaceMembers.findFirst({
      where: and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, user.id)),
    });

    if (existingMember) {
      return c.json({ error: "You're already a member", spaceSlug: space.slug }, 400);
    }

    // Add as member and mark link claimed
    await db.insert(spaceMembers).values({
      spaceId: space.id,
      userId: user.id,
      role: link.role,
    });

    await db
      .update(shareLinks)
      .set({ claimedBy: user.id, claimedAt: new Date() })
      .where(eq(shareLinks.id, link.id));

    return c.json({ spaceSlug: space.slug, role: link.role });
  });

  return router;
}
