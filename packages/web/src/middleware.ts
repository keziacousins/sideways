import { defineMiddleware } from "astro:middleware";
import { accessSync, constants } from "node:fs";

const API_URL = import.meta.env.PUBLIC_API_URL || "http://localhost:4100";
const PUBLIC_URL = import.meta.env.PUBLIC_URL || "http://localhost:4000";

// Startup smoke test: in production, the session fs driver must be writing
// to /var/lib/sideways/sessions (systemd StateDirectory). If we ship a build
// where that path isn't reachable, sessions land in the build dir instead
// and every deploy logs every user out. The actual base is configured in
// astro.config.mjs; this is the boundary check that catches a config drift.
const PROD_SESSION_BASE = "/var/lib/sideways/sessions";
if (import.meta.env.PROD) {
  try {
    accessSync(PROD_SESSION_BASE, constants.W_OK);
    console.log(`[startup] Session storage OK at ${PROD_SESSION_BASE}`);
  } catch {
    console.error(
      `[startup] FATAL: ${PROD_SESSION_BASE} not writable. Sessions will NOT persist across restarts — every deploy will log out all users. Check StateDirectory= in sideways-web.service and astro.config.mjs session.driver.config.base.`,
    );
  }
}

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Proxy-aware CSRF check. Replaces Astro's built-in `checkOrigin`, which
 * compares against the request's Host header — wrong behind an HTTPS-
 * terminating reverse proxy where the inner connection is http://localhost.
 *
 * Rules:
 *   - GET/HEAD/OPTIONS: skip (no state change).
 *   - State-changing: require Origin to match PUBLIC_URL exactly. Missing
 *     or mismatched Origin → 403.
 *
 * SameSite=Lax on the session cookie already blocks most cross-site POSTs;
 * this is defense-in-depth for browser primitives that bypass SameSite.
 */
function checkOrigin(request: Request): Response | null {
  if (!STATE_CHANGING_METHODS.has(request.method)) return null;
  const origin = request.headers.get("origin");
  if (origin !== PUBLIC_URL) {
    return new Response("Cross-site request forbidden", {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return null;
}

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
  const csrf = checkOrigin(context.request);
  if (csrf) return csrf;

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
        } else {
          // Refresh failed — session is dead, redirect to login
          await session?.set("access_token", null);
          await session?.set("refresh_token", null);
          await session?.set("user_name", null);
          await session?.set("user_email", null);
          const returnTo = encodeURIComponent(context.url.pathname);
          return context.redirect(`/auth/login?returnTo=${returnTo}`);
        }
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
