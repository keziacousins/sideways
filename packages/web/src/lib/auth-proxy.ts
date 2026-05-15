/**
 * Server-side helper for the internal RPC endpoints under `pages/op/`.
 * Refreshes the session's access token if it's near expiry, then forwards
 * a request to the API server with `Authorization: Bearer ...`.
 *
 * Centralised so each action endpoint stays a thin proxy without
 * duplicating the OAuth refresh dance.
 */

const API_URL = import.meta.env.PUBLIC_API_URL || "http://localhost:4100";

export async function getFreshToken(session: any): Promise<string | null> {
  let accessToken = await session?.get("access_token");
  const refreshToken = await session?.get("refresh_token");
  if (!accessToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64").toString());
    if (Date.now() > payload.exp * 1000 - 30_000) {
      if (!refreshToken) return null;
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
        if (tokens.refresh_token) await session?.set("refresh_token", tokens.refresh_token);
      } else return null;
    }
  } catch { return null; }
  return accessToken;
}

export { API_URL };
