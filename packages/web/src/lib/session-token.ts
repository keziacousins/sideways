/**
 * Browser-side helper for client components that call the API directly.
 * When the access token a component was rendered with has expired, this
 * fetches the session's current one from the web server. The browser never
 * sees the refresh token — see the note on the middleware.
 *
 * Concurrent callers share one request.
 */
let inFlight: Promise<string | null> | null = null;

export function fetchSessionToken(): Promise<string | null> {
  inFlight ??= fetch("/op/token", { method: "POST" })
    .then(async (res) => (res.ok ? ((await res.json()).access_token as string) : null))
    .catch(() => null)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Fetch from the API as the signed-in user. `tokenRef` holds the token the
 * component was rendered with, and is updated in place if that has expired.
 */
export async function authFetch(url: string, apiUrl: string, tokenRef: { current: string | null }, opts?: RequestInit) {
  const doFetch = () => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (tokenRef.current) headers["Authorization"] = `Bearer ${tokenRef.current}`;
    return fetch(`${apiUrl}${url}`, { ...opts, headers });
  };

  let res = await doFetch();

  // The token this page was rendered with has expired — pick up the session's current one
  if (res.status === 401 && tokenRef.current) {
    const token = await fetchSessionToken();
    if (token && token !== tokenRef.current) {
      tokenRef.current = token;
      res = await doFetch();
    }
  }

  return res;
}
