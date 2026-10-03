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

/** A browser navigation, as opposed to a fetch() from page script. */
function isNavigation(request: Request): boolean {
  return request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html");
}

/**
 * Outcome of a refresh attempt. "invalid" means the refresh token itself was
 * rejected, so the session is dead. "unavailable" is anything else — the API
 * restarting mid-deploy, a rate limit, a network error — and says nothing
 * about the session, so it must not be thrown away.
 */
type RefreshResult = { access_token: string; refresh_token?: string } | "invalid" | "unavailable";

/**
 * In-flight refresh deduplication.
 * Keyed by refresh token — concurrent requests share the same promise.
 */
let refreshInFlight: Promise<RefreshResult> | null = null;
let refreshForToken: string | null = null;

function refresh(refreshToken: string): Promise<RefreshResult> {
  if (refreshInFlight && refreshForToken === refreshToken) return refreshInFlight;

  const attempt = doRefresh(refreshToken).finally(() => {
    if (refreshInFlight === attempt) {
      refreshInFlight = null;
      refreshForToken = null;
    }
  });
  refreshInFlight = attempt;
  refreshForToken = refreshToken;
  return attempt;
}

async function doRefresh(refreshToken: string): Promise<RefreshResult> {
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
    return res.status === 400 || res.status === 401 ? "invalid" : "unavailable";
  } catch {
    console.error("[middleware] Token refresh failed (network error)");
    return "unavailable";
  }
}

/**
 * Astro middleware — runs on every SSR request.
 * Reads the session, refreshes the access token if expired,
 * and stores a fresh token on `Astro.locals.accessToken`.
 *
 * This is the only place the refresh token is used. Refresh tokens are
 * single-use, and Hydra revokes the whole chain when a spent one is presented
 * again, so a second refresher — another endpoint, or the browser — signs the
 * user out. Endpoints read `locals.accessToken`; client components call
 * `/op/token`.
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
    let expiresAt = 0;

    try {
      const payload = JSON.parse(
        Buffer.from(accessToken.split(".")[1], "base64").toString(),
      );
      expiresAt = payload.exp * 1000;
      needsRefresh = Date.now() > expiresAt - 5 * 60_000; // refresh 5 min before expiry
    } catch {
      needsRefresh = true;
    }

    if (needsRefresh && refreshToken) {
      const result = await refresh(refreshToken);

      if (result === "invalid") {
        // The refresh token was rejected — session is dead
        accessToken = null;
        await session?.set("access_token", null);
        await session?.set("refresh_token", null);
        await session?.set("user_name", null);
        await session?.set("user_email", null);
        // Send a navigation to login. A fetch() carries on signed out, so the
        // endpoint answers 401 instead of the caller receiving a login page.
        if (isNavigation(context.request)) {
          const returnTo = encodeURIComponent(context.url.pathname);
          return context.redirect(`/auth/login?returnTo=${returnTo}`);
        }
      } else if (result === "unavailable") {
        // Keep the session and retry on the next request. Until expiry the
        // current token still works; past it there is nothing to send.
        if (!(Date.now() < expiresAt)) {
          return new Response("Could not refresh your session. Try again in a moment.", {
            status: 503,
            headers: { "Content-Type": "text/plain", "Retry-After": "5" },
          });
        }
      } else {
        accessToken = result.access_token;
        await session?.set("access_token", result.access_token);
        if (result.refresh_token) {
          await session?.set("refresh_token", result.refresh_token);
        }
        // Session keys expire one by one, a ttl after each was last written.
        // Rewrite the login-time keys with the tokens so the session slides
        // as a whole, rather than losing the user's name a week after login.
        for (const key of ["id_token", "user_email", "user_name"]) {
          const value = await session?.get(key);
          if (value != null) await session?.set(key, value);
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
