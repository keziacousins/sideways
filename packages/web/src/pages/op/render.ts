import type { APIRoute } from "astro";
import { getFreshToken, API_URL } from "../../lib/auth-proxy.ts";

/**
 * POST /op/render
 * Body: { space, section, path, content } — render arbitrary markdown using
 * the doc at (section, path) as the wikilink resolution context.
 */
export const POST: APIRoute = async ({ request, session }) => {
  const token = await getFreshToken(session);
  if (!token) return jsonError("Not authenticated", 401);

  const body = await request.json();
  const { space, section, path, content } = body;
  if (!space || !section || !path) return jsonError("space, section and path are required", 400);

  const res = await fetch(
    `${API_URL}/api/documents/${space}/${section}/_render/${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content }),
    },
  );

  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
};

function jsonError(msg: string, status: number) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
