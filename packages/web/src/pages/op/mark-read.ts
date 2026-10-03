import type { APIRoute } from "astro";
import { API_URL } from "../../lib/auth-proxy.ts";

/**
 * POST /op/mark-read
 * Body: { space }
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const token = locals.accessToken;
  if (!token) return jsonError("Not authenticated", 401);

  const { space } = await request.json();
  if (!space) return jsonError("space is required", 400);

  const res = await fetch(
    `${API_URL}/api/documents/${space}/_read-all`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } },
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
