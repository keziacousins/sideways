import type { APIRoute } from "astro";
import { apiFetch } from "../../../../lib/api.ts";

/**
 * /a/<space>/<section>/<path> — a hosted asset.
 *
 * The API authenticates with a Bearer token, and the browser doesn't hold
 * one: it lives in the server-side session. So an `<img>` can't point at
 * `/api/assets/…` unless the space is public. This route is where rendered
 * documents point instead — it attaches the session's token and streams the
 * API's answer back.
 *
 *   GET — serve the bytes.
 *   PUT — upload them; the editor does this for a pasted or dropped file.
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

function apiPath(params: Record<string, string | undefined>): string {
  const path = (params.path ?? "").split("/").map(encodeURIComponent).join("/");
  const space = encodeURIComponent(params.space ?? "");
  const section = encodeURIComponent(params.section ?? "");
  return `/api/assets/${space}/${section}/${path}`;
}

/** `If-None-Match`, if the request carries one, ready to forward. */
function conditional(request: Request): Record<string, string> {
  const ifNoneMatch = request.headers.get("If-None-Match");
  return ifNoneMatch ? { "If-None-Match": ifNoneMatch } : {};
}

export const GET: APIRoute = async ({ params, request, locals }) => {
  // Forward the validator so an unchanged asset costs a 304, not a download.
  const res = await apiFetch(apiPath(params), locals.accessToken, {
    headers: conditional(request),
  });

  const headers = new Headers();
  for (const name of PASS_THROUGH) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }

  return new Response(res.body, { status: res.status, headers });
};

export const PUT: APIRoute = async ({ params, request, locals }) => {
  if (!locals.accessToken) {
    return new Response(JSON.stringify({ error: "Not authenticated" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // `If-None-Match: *` is how the editor asks not to replace an existing file.
  const res = await apiFetch(apiPath(params), locals.accessToken, {
    method: "PUT",
    headers: conditional(request),
    body: await request.arrayBuffer(),
  });

  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
};
