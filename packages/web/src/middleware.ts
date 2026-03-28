import { defineMiddleware } from "astro:middleware";

const API_URL = import.meta.env.PUBLIC_API_URL || "http://localhost:4100";

/**
 * In-flight refresh deduplication.
 * Keyed by refresh token — concurrent requests share the same promise.
 */
let refreshInFlight: Promise<{ access_token: string; refresh_token?: string } | null> | null = null;
let refreshForToken: string | null = null;

async function doRefresh(refreshToken: string): Promise<{ access_token: string; refresh_token?: string } | null> {
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
      return await res.json();
    }
    console.error(`[middleware] Token refresh failed: ${res.status}`);
    return null;
  } catch {
    console.error("[middleware] Token refresh failed (network error)");
    return null;
  }
}

/**
 * Astro middleware — runs on every SSR request.
 * Reads the session, refreshes the access token if expired,
 * and stores a fresh token on `Astro.locals.accessToken`.
 *
 * Refresh is deduplicated: if multiple concurrent requests need to refresh,
 * only one actual refresh call is made. The rest wait for the same result.
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
      needsRefresh = true;
    }

    if (needsRefresh && refreshToken) {
      // Deduplicate: if a refresh is already in-flight for this token, wait for it
      if (refreshInFlight && refreshForToken === refreshToken) {
        const result = await refreshInFlight;
        if (result) {
          accessToken = result.access_token;
        }
      } else {
        // Start a new refresh and let concurrent requests share it
        refreshForToken = refreshToken;
        refreshInFlight = doRefresh(refreshToken);

        const result = await refreshInFlight;
        refreshInFlight = null;
        refreshForToken = null;

        if (result) {
          accessToken = result.access_token;
          await session?.set("access_token", result.access_token);
          if (result.refresh_token) {
            await session?.set("refresh_token", result.refresh_token);
          }
        }
        // On failure: keep stale token, don't clear session
      }
    } else if (needsRefresh && !refreshToken) {
      accessToken = null;
      await session?.set("access_token", null);
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

  context.locals.accessToken = accessToken || null;

  return next();
});
