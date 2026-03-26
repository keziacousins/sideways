import type { APIRoute } from "astro";
import { apiFetch } from "../../../../lib/api.ts";

export const DELETE: APIRoute = async ({ params, locals }) => {
  if (!locals.accessToken) return new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401, headers: { "Content-Type": "application/json" } });

  const res = await apiFetch(`/api/spaces/${params.space}/members/${params.memberId}`, locals.accessToken, {
    method: "DELETE",
  });

  return new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json" } });
};
