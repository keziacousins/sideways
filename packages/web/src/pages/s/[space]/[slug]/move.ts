import type { APIRoute } from "astro";
import { apiFetch } from "../../../../lib/api.ts";

export const POST: APIRoute = async ({ params, request, locals }) => {
  if (!locals.accessToken) return new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401, headers: { "Content-Type": "application/json" } });

  const body = await request.json();
  const res = await apiFetch(`/api/documents/${params.space}/${params.slug}`, locals.accessToken, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json" } });
};
