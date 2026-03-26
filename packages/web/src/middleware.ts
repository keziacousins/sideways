import { defineMiddleware } from "astro:middleware";

const API_URL = import.meta.env.PUBLIC_API_URL || "http://localhost:4100";

/**
 * Astro middleware — runs on every SSR request.
 * Reads the session, refreshes the access token if expired,
 * and stores a fresh token on `Astro.locals.accessToken`.
 * Pages use this for authenticated API calls.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const { session } = context;

  let accessToken = await session?.get("access_token");
  const refreshToken = await session?.get("refresh_token");

  if (accessToken) {
    // Check if JWT is expired or about to expire
    try {
      const payload = JSON.parse(
        Buffer.from(accessToken.split(".")[1], "base64").toString(),
      );
      const expiresAt = payload.exp * 1000;

      if (Date.now() > expiresAt - 30_000) {
        // Expired or expiring within 30s — refresh
        if (refreshToken) {
          const res = await fetch(`${API_URL}/api/auth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: refreshToken,
              client_id: "sideways-web",
            }),
          });

          if (res.ok) {
            const tokens = await res.json();
            accessToken = tokens.access_token;
            await session?.set("access_token", tokens.access_token);
            if (tokens.refresh_token) {
              await session?.set("refresh_token", tokens.refresh_token);
            }
          } else {
            // Refresh failed — clear tokens
            accessToken = null;
            await session?.set("access_token", null);
          }
        } else {
          accessToken = null;
        }
      }
    } catch {
      // Not a valid JWT — use as-is or clear
    }
  }

  // Store on locals for pages to use
  context.locals.accessToken = accessToken || null;

  return next();
});
