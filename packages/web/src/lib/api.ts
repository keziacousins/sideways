const API_URL = import.meta.env.PUBLIC_API_URL || "http://localhost:4100";

/**
 * Make an authenticated API fetch using the token from Astro locals.
 * Falls back to anonymous if no token available.
 */
export async function apiFetch(
  path: string,
  accessToken: string | null,
  options?: RequestInit,
): Promise<Response> {
  const headers: Record<string, string> = {
    ...((options?.headers as Record<string, string>) || {}),
  };
  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  return fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  });
}
