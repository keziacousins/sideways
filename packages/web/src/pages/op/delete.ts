import type { APIRoute } from "astro";
import { API_URL } from "../../lib/auth-proxy.ts";

/**
 * POST /op/delete
 * Body: { space, section, path }
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const token = locals.accessToken;
  if (!token) return jsonError("Not authenticated", 401);

  const { space, section, path } = await request.json();
  if (!space || !section || !path) return jsonError("space, section and path are required", 400);

  const res = await fetch(
    `${API_URL}/api/documents/${space}/${section}/${path}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
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
