import type { APIRoute } from "astro";
import { getFreshToken, API_URL } from "../../lib/auth-proxy.ts";

/**
 * GET /op/pdf?space=&section=&path=&theme=&toc=&title-page=
 *
 * Triggered by an anchor click for download, so it has to be a GET that
 * returns the PDF directly. All targeting fields come from query string.
 */
export const GET: APIRoute = async ({ request, session }) => {
  const token = await getFreshToken(session);
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const url = new URL(request.url);
  const space = url.searchParams.get("space");
  const section = url.searchParams.get("section");
  const path = url.searchParams.get("path");
  if (!space || !section || !path) {
    return new Response(JSON.stringify({ error: "space, section and path are required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Forward through-passing query params (theme, toc, title-page).
  const forwarded = new URLSearchParams(url.searchParams);
  forwarded.delete("space");
  forwarded.delete("section");
  forwarded.delete("path");
  const qs = forwarded.toString();

  const res = await fetch(
    `${API_URL}/api/documents/${space}/${section}/_pdf/${path}${qs ? `?${qs}` : ""}`,
    { headers },
  );

  if (!res.ok) {
    return new Response(await res.text(), {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const baseName = path.replace(/\.md$/, "").split("/").pop() || "document";
  return new Response(res.body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition":
        res.headers.get("Content-Disposition") || `attachment; filename="${baseName}.pdf"`,
    },
  });
};
