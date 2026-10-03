import type { APIRoute } from "astro";

const API_URL = import.meta.env.PUBLIC_API_URL || "http://localhost:4100";

export const POST: APIRoute = async ({ request, locals }) => {
  const token = locals.accessToken;
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
