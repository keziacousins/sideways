import type { APIRoute } from "astro";

/**
 * POST /op/token
 * Returns the session's current access token. The middleware has already
 * refreshed it if it was near expiry, so client components call this after
 * a 401 instead of holding a refresh token themselves.
 */
export const POST: APIRoute = async ({ locals }) => {
  const token = locals.accessToken;
  return new Response(
    JSON.stringify(token ? { access_token: token } : { error: "Not authenticated" }),
    {
      status: token ? 200 : 401,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    },
  );
};
