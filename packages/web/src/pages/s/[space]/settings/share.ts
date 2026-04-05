import type { APIRoute } from "astro";
import { apiFetch } from "../../../../lib/api.ts";

/** Create a share link */
export const POST: APIRoute = async ({ params, request, locals }) => {
  if (!locals.accessToken) return new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401, headers: { "Content-Type": "application/json" } });

  const body = await request.json();
  const res = await apiFetch(`/api/spaces/${params.space}/share`, locals.accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json" } });
};

/** List active share links */
export const GET: APIRoute = async ({ params, locals }) => {
  if (!locals.accessToken) return new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401, headers: { "Content-Type": "application/json" } });

  const res = await apiFetch(`/api/spaces/${params.space}/share`, locals.accessToken);

  return new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json" } });
};
