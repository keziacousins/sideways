import type { APIRoute } from "astro";
import { getFreshToken, API_URL } from "../../lib/auth-proxy.ts";

/**
 * GET  /op/doc-watch?space=&section=&path=  — check current watch state
 * POST /op/doc-watch  body: { space, section, path }  — toggle
 */
export const GET: APIRoute = async ({ request, session }) => {
  const token = await getFreshToken(session);
  if (!token) return new Response(JSON.stringify({ watching: false }), { headers: jsonHeaders() });

  const url = new URL(request.url);
  const space = url.searchParams.get("space");
  const section = url.searchParams.get("section");
  const path = url.searchParams.get("path");
  if (!space || !section || !path) return jsonError("space, section and path are required", 400);

  const res = await fetch(
    `${API_URL}/api/documents/${space}/${section}/_watch/${path}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return new Response(await res.text(), { status: res.status, headers: jsonHeaders() });
};

export const POST: APIRoute = async ({ request, session }) => {
  const token = await getFreshToken(session);
  if (!token) return jsonError("Not authenticated", 401);

  const { space, section, path } = await request.json();
  if (!space || !section || !path) return jsonError("space, section and path are required", 400);

  const res = await fetch(
    `${API_URL}/api/documents/${space}/${section}/_watch/${path}`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } },
  );
  return new Response(await res.text(), { status: res.status, headers: jsonHeaders() });
};

const jsonHeaders = () => ({ "Content-Type": "application/json" });
const jsonError = (msg: string, status: number) =>
  new Response(JSON.stringify({ error: msg }), { status, headers: jsonHeaders() });
