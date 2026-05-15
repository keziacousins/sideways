import type { APIRoute } from "astro";
import { getFreshToken, API_URL } from "../../lib/auth-proxy.ts";

/**
 * POST /op/patch
 * Body: { space, section, path, ...patchFields } — patch fields may include
 * `title`, `tags`, `position`, `targetSection`, `targetPath`, `targetSpace`,
 * `parentPath`. Forwards to PATCH /api/documents/...
 */
export const POST: APIRoute = async ({ request, session }) => {
  const token = await getFreshToken(session);
  if (!token) return jsonError("Not authenticated", 401);

  const body = await request.json();
  const { space, section, path, ...patchFields } = body;
  if (!space || !section || !path) return jsonError("space, section and path are required", 400);

  const res = await fetch(
    `${API_URL}/api/documents/${space}/${section}/${path}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(patchFields),
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
