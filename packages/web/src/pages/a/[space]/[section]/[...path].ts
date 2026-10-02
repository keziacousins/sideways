import type { APIRoute } from "astro";
import { apiFetch } from "../../../../lib/api.ts";

/**
 * GET /a/<space>/<section>/<path> — serve a hosted asset.
 *
 * The API authenticates with a Bearer token, and the browser doesn't hold
 * one: it lives in the server-side session. So an `<img>` can't point at
 * `/api/assets/…` unless the space is public. This route is where rendered
 * documents point instead — it attaches the session's token and streams the
 * API's answer back.
 */

// What the API decided about the asset, passed through untouched. The CSP in
// particular: it is what makes an SVG opened in its own tab inert.
const PASS_THROUGH = [
  "Content-Type",
  "Content-Length",
  "Content-Disposition",
  "Content-Security-Policy",
  "X-Content-Type-Options",
  "Cache-Control",
  "ETag",
];

export const GET: APIRoute = async ({ params, request, locals }) => {
  const path = (params.path ?? "").split("/").map(encodeURIComponent).join("/");
  const space = encodeURIComponent(params.space ?? "");
  const section = encodeURIComponent(params.section ?? "");

  // Forward the validator so an unchanged asset costs a 304, not a download.
  const conditional: Record<string, string> = {};
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch) conditional["If-None-Match"] = ifNoneMatch;

  const res = await apiFetch(`/api/assets/${space}/${section}/${path}`, locals.accessToken, {
    headers: conditional,
  });

  const headers = new Headers();
  for (const name of PASS_THROUGH) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }

  return new Response(res.body, { status: res.status, headers });
};
