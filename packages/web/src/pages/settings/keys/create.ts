import type { APIRoute } from "astro";

const API_URL = import.meta.env.PUBLIC_API_URL || "http://localhost:4100";

async function getFreshToken(session: any): Promise<string | null> {
  let accessToken = await session?.get("access_token");
  const refreshToken = await session?.get("refresh_token");
  if (!accessToken) return null;

  // Check expiry
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split(".")[1], "base64").toString(),
    );
    if (Date.now() > payload.exp * 1000 - 30_000) {
      // Refresh
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
        if (tokens.refresh_token) {
          await session?.set("refresh_token", tokens.refresh_token);
        }
      } else {
        return null;
      }
    }
  } catch {
    return null;
  }

  return accessToken;
}

export const POST: APIRoute = async ({ request, session }) => {
  const token = await getFreshToken(session);
  if (!token) {
    return new Response(JSON.stringify({ error: "Not authenticated" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = await request.json();

  const res = await fetch(`${API_URL}/api/keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      name: body.name || "Untitled",
      // Pass actorName through — the form exposes an agent-name input
      // (settings/keys.astro) and the API accepts it (routes/keys.ts).
      // This proxy used to drop it silently; see issue #42.
      actorName: body.actorName || null,
    }),
  });

  const data = await res.json();
  return new Response(JSON.stringify(data), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
};
