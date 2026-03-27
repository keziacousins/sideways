import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { type Database, themes } from "@sideways/db";
import type { Storage } from "@sideways/storage";

export function createThemeRoutes(db: Database, storage: Storage) {
  const router = new Hono();

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

  /** Create a theme */
  router.post("/", async (c) => {
    const body = await c.req.json<{
      name: string;
      tokens?: Record<string, any>;
    }>();

    if (!body.name) return c.json({ error: "Name required" }, 400);

    const [theme] = await db
      .insert(themes)
      .values({
        name: body.name,
        tokens: body.tokens || {},
      })
      .returning();

    return c.json(theme, 201);
  });

  /** Update a theme */
  router.put("/:id", async (c) => {
    const existing = await db.query.themes.findFirst({
      where: eq(themes.id, c.req.param("id")),
    });
    if (!existing) return c.json({ error: "Theme not found" }, 404);

    const body = await c.req.json<{
      name?: string;
      tokens?: Record<string, any>;
    }>();

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

  /** Delete a theme */
  router.delete("/:id", async (c) => {
    const existing = await db.query.themes.findFirst({
      where: eq(themes.id, c.req.param("id")),
    });
    if (!existing) return c.json({ error: "Theme not found" }, 404);

    await db.delete(themes).where(eq(themes.id, existing.id));
    return c.json({ deleted: true });
  });

  /** Upload a logo for a theme */
  router.post("/:id/logo", async (c) => {
    const existing = await db.query.themes.findFirst({
      where: eq(themes.id, c.req.param("id")),
    });
    if (!existing) return c.json({ error: "Theme not found" }, 404);

    const contentType = c.req.header("content-type") || "image/png";
    const body = await c.req.arrayBuffer();

    // Store in SeaweedFS
    const ext = contentType.includes("svg") ? "svg" : contentType.includes("png") ? "png" : "jpg";
    const filename = `theme-${existing.id}-logo.${ext}`;
    const result = await storage.upload(`/themes/${filename}`, Buffer.from(body), contentType);
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
      const mimeTypes: Record<string, string> = { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg" };

      return new Response(res.body, {
        headers: {
          "Content-Type": mimeTypes[ext] || "image/png",
          "Cache-Control": "public, max-age=86400",
        },
      });
    } catch {
      return c.json({ error: "Logo not found in storage" }, 404);
    }
  });

  return router;
}
