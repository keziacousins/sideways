import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { type Database, themes } from "@sideways/db";
import type { Storage } from "@sideways/storage";
import { requireAuth, type AuthUser } from "../middleware/auth.js";
import { validateLogoUpload } from "../middleware/themeLogo.js";

const MAX_NAME_LENGTH = 100;

export function createThemeRoutes(db: Database, storage: Storage) {
  const router = new Hono();

  // All theme routes require authentication
  router.use("*", requireAuth());

  /** List all themes */
  router.get("/", async (c) => {
    const all = await db.query.themes.findMany({
      orderBy: (t, { asc }) => asc(t.name),
    });
    return c.json(all);
  });

  /** Get a single theme */
  router.get("/:id", async (c) => {
    const theme = await db.query.themes.findFirst({
      where: eq(themes.id, c.req.param("id")),
    });
    if (!theme) return c.json({ error: "Theme not found" }, 404);
    return c.json(theme);
  });

  /** Create a theme — the caller becomes the owner. */
  router.post("/", async (c) => {
    const body = await c.req.json<{
      name: string;
      tokens?: Record<string, any>;
    }>();

    if (!body.name) return c.json({ error: "Name required" }, 400);
    if (body.name.length > MAX_NAME_LENGTH) {
      return c.json({ error: `Name too long (max ${MAX_NAME_LENGTH})` }, 400);
    }

    const user = c.get("user") as AuthUser;
    const [theme] = await db
      .insert(themes)
      .values({
        name: body.name,
        tokens: body.tokens || {},
        createdBy: user.id,
      })
      .returning();

    return c.json(theme, 201);
  });

  /**
   * Mutating routes (PUT/DELETE/logo upload) require the caller to be the
   * theme's owner. Themes with no owner (pre-migration rows) are treated as
   * immutable; an admin can re-assign them by setting createdBy directly.
   */
  function requireOwnership(existing: { createdBy: string | null }, user: AuthUser): boolean {
    return existing.createdBy !== null && existing.createdBy === user.id;
  }

  /** Update a theme — owner only */
  router.put("/:id", async (c) => {
    const existing = await db.query.themes.findFirst({
      where: eq(themes.id, c.req.param("id")),
    });
    if (!existing) return c.json({ error: "Theme not found" }, 404);

    const user = c.get("user") as AuthUser;
    if (!requireOwnership(existing, user)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const body = await c.req.json<{
      name?: string;
      tokens?: Record<string, any>;
    }>();

    if (body.name && body.name.length > MAX_NAME_LENGTH) {
      return c.json({ error: `Name too long (max ${MAX_NAME_LENGTH})` }, 400);
    }

    const [updated] = await db
      .update(themes)
      .set({
        name: body.name ?? existing.name,
        tokens: body.tokens ?? existing.tokens,
        updatedAt: new Date(),
      })
      .where(eq(themes.id, existing.id))
      .returning();

    return c.json(updated);
  });

  /** Delete a theme — owner only */
  router.delete("/:id", async (c) => {
    const existing = await db.query.themes.findFirst({
      where: eq(themes.id, c.req.param("id")),
    });
    if (!existing) return c.json({ error: "Theme not found" }, 404);

    const user = c.get("user") as AuthUser;
    if (!requireOwnership(existing, user)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    await db.delete(themes).where(eq(themes.id, existing.id));
    return c.json({ deleted: true });
  });

  /** Upload a logo for a theme — owner only, validated content */
  router.post("/:id/logo", async (c) => {
    const existing = await db.query.themes.findFirst({
      where: eq(themes.id, c.req.param("id")),
    });
    if (!existing) return c.json({ error: "Theme not found" }, 404);

    const user = c.get("user") as AuthUser;
    if (!requireOwnership(existing, user)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const body = await c.req.arrayBuffer();
    const validation = validateLogoUpload(body);
    if ("error" in validation) {
      return c.json({ error: validation.error }, 400);
    }
    const { bytes, mimeType, extension } = validation;

    const filename = `theme-${existing.id}-logo.${extension}`;
    const result = await storage.upload(`/themes/${filename}`, Buffer.from(bytes), mimeType);
    const storageKey = result.path;

    // Build public URL
    const logoUrl = `/api/themes/${existing.id}/logo`;

    // Update theme tokens with logo URL
    const tokens = (existing.tokens as Record<string, any>) || {};
    tokens.logo = logoUrl;

    await db
      .update(themes)
      .set({
        tokens,
        logoAssets: [storageKey],
        updatedAt: new Date(),
      })
      .where(eq(themes.id, existing.id));

    return c.json({ logo: logoUrl, storageKey });
  });

  /** Serve a theme's logo */
  router.get("/:id/logo", async (c) => {
    const theme = await db.query.themes.findFirst({
      where: eq(themes.id, c.req.param("id")),
    });
    if (!theme || !theme.logoAssets?.length) return c.json({ error: "No logo" }, 404);

    try {
      const res = await storage.download(theme.logoAssets[0]);
      const ext = theme.logoAssets[0].split(".").pop() || "png";
      const mimeTypes: Record<string, string> = {
        svg: "image/svg+xml",
        png: "image/png",
        jpg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
      };

      return new Response(res.body, {
        headers: {
          "Content-Type": mimeTypes[ext] || "image/png",
          // Force SVG (and anything else) to render in <img>, not inline.
          // CSP would do the same; this is belt-and-braces.
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "public, max-age=86400",
        },
      });
    } catch {
      return c.json({ error: "Logo not found in storage" }, 404);
    }
  });

  return router;
}
