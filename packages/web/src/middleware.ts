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
    let needsRefresh = false;

    try {
      const payload = JSON.parse(
        Buffer.from(accessToken.split(".")[1], "base64").toString(),
      );
      const expiresAt = payload.exp * 1000;
      needsRefresh = Date.now() > expiresAt - 5 * 60_000; // refresh 5 min before expiry
    } catch {
      // Can't decode JWT — treat as expired
      needsRefresh = true;
    }

    if (needsRefresh) {
      if (refreshToken) {
        try {
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
            // Refresh failed — keep the stale access token rather than
            // logging the user out. It might still work for some requests
            // and the next page load will retry the refresh.
            console.error(`[middleware] Token refresh failed: ${res.status}`);
          }
        } catch {
          // Network error reaching API — keep stale token rather than
          // logging user out due to a transient failure
          console.error("[middleware] Token refresh failed (network error)");
        }
      } else {
        // No refresh token — can't renew
        accessToken = null;
        await session?.set("access_token", null);
      }
    }
  }

  // If tokens are gone but user info remains, clean up the stale session
  if (!accessToken && !refreshToken) {
    const userName = await session?.get("user_name");
    if (userName) {
      await session?.set("user_name", null);
      await session?.set("user_email", null);
    }
  }

  // Store on locals for pages to use
  context.locals.accessToken = accessToken || null;

  return next();
});
