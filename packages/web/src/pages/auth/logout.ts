import type { APIRoute } from "astro";

/**
 * Clears the session and redirects to home.
 */
export const GET: APIRoute = async ({ redirect, session }) => {
  await session?.destroy();
  return redirect("/");
};
