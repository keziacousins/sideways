import type { APIRoute } from "astro";
import { getFreshToken, API_URL } from "../../lib/auth-proxy.ts";

/**
 * GET  /op/space-watch?space=  — check current watch state on a space
 * POST /op/space-watch  body: { space }  — toggle
 */
export const GET: APIRoute = async ({ request, session }) => {
  const token = await getFreshToken(session);
  if (!token) return new Response(JSON.stringify({ watching: false }), { headers: jsonHeaders() });

  const space = new URL(request.url).searchParams.get("space");
  if (!space) return jsonError("space is required", 400);

  const res = await fetch(
    `${API_URL}/api/spaces/${space}/watch`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return new Response(await res.text(), { status: res.status, headers: jsonHeaders() });
};

export const POST: APIRoute = async ({ request, session }) => {
  const token = await getFreshToken(session);
  if (!token) return jsonError("Not authenticated", 401);

  const { space } = await request.json();
  if (!space) return jsonError("space is required", 400);

  const res = await fetch(
    `${API_URL}/api/spaces/${space}/watch`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } },
  );
  return new Response(await res.text(), { status: res.status, headers: jsonHeaders() });
};

const jsonHeaders = () => ({ "Content-Type": "application/json" });
const jsonError = (msg: string, status: number) =>
  new Response(JSON.stringify({ error: msg }), { status, headers: jsonHeaders() });
