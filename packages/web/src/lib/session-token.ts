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
