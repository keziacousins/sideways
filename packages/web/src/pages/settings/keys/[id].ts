import type { APIRoute } from "astro";

const API_URL = import.meta.env.PUBLIC_API_URL || "http://localhost:4100";

export const DELETE: APIRoute = async ({ params, locals }) => {
  const token = locals.accessToken;
  if (!token) {
    return new Response(JSON.stringify({ error: "Not authenticated" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const res = await fetch(`${API_URL}/api/keys/${params.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  const data = await res.json();
  return new Response(JSON.stringify(data), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
};
