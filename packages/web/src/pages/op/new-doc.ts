import type { APIRoute } from "astro";
import { docUrl } from "@sideways/types";
import { getFreshToken, API_URL } from "../../lib/auth-proxy.ts";

/**
 * POST /op/new-doc
 * Body: { space }
 *
 * Creates an empty "Untitled" doc in the space's `default` section, finding
 * a unique path by appending a numeric suffix. Returns the doc's canonical
 * URL with `?edit=1` so the client can navigate straight into edit mode.
 */
export const POST: APIRoute = async ({ request, session }) => {
  const token = await getFreshToken(session);
  if (!token) return jsonError("Not authenticated", 401);

  const { space } = await request.json();
  if (!space) return jsonError("space is required", 400);

  const section = "default";

  // Find a unique path under the default section
  let path = "untitled.md";
  let suffix = 0;
  while (true) {
    const candidate = suffix === 0 ? path : `untitled-${suffix}.md`;
    const check = await fetch(`${API_URL}/api/documents/${space}/${section}/${candidate}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (check.status === 404) {
      path = candidate;
      break;
    }
    suffix++;
    if (suffix > 50) {
      path = `untitled-${Date.now()}.md`;
      break;
    }
  }

  const title = suffix === 0 ? "Untitled" : `Untitled ${suffix}`;
  const res = await fetch(`${API_URL}/api/documents/${space}/${section}/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ content: "", title }),
  });

  if (!res.ok) {
    return new Response(await res.text(), {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = docUrl({ spaceSlug: space, sectionSlug: section, path });
  return new Response(JSON.stringify({ url: `${url}?edit=1`, section, path }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

function jsonError(msg: string, status: number) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
