import type { APIRoute } from "astro";
import { apiFetch } from "../../../lib/api.ts";

/**
 * /d/<space>/<hash>.svg — a rendered Typst diagram (see issue #117).
 *
 * Same arrangement as /a/ for hosted assets: an `<img>` in a rendered
 * document can't carry the API's Bearer token, which lives in the
 * server-side session, so this route attaches it and streams the answer back.
 */

// What the API decided, passed through untouched — the CSP in particular,
// which keeps an SVG opened in its own tab inert.
const PASS_THROUGH = [
  "Content-Type",
  "Content-Length",
  "Content-Security-Policy",
  "X-Content-Type-Options",
  "Cache-Control",
  "ETag",
];

export const GET: APIRoute = async ({ params, request, locals }) => {
  const space = encodeURIComponent(params.space ?? "");
  const file = encodeURIComponent(params.file ?? "");
  const ifNoneMatch = request.headers.get("If-None-Match");

  const res = await apiFetch(`/api/diagrams/${space}/${file}`, locals.accessToken, {
    headers: ifNoneMatch ? { "If-None-Match": ifNoneMatch } : {},
  });

  const headers = new Headers();
  for (const name of PASS_THROUGH) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(res.body, { status: res.status, headers });
};
