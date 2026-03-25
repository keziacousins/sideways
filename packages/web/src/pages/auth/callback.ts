import type { APIRoute } from "astro";

const HYDRA_PUBLIC = import.meta.env.HYDRA_PUBLIC_URL || "http://localhost:4444";
const CLIENT_ID = "sideways-web";
const CLIENT_SECRET = import.meta.env.HYDRA_CLIENT_SECRET || "znuld0L9Z6hKYSwcjYr0uSm5ll";
const REDIRECT_URI = "http://localhost:4000/auth/callback";

/**
 * OAuth2 callback — exchanges authorization code for tokens,
 * stores them in the Astro session, and redirects to home.
 */
export const GET: APIRoute = async ({ request, redirect, session }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return redirect(`/?error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return redirect("/?error=missing_code");
  }

  // Validate state
  const expectedState = await session?.get("oauth_state");
  if (state !== expectedState) {
    return redirect("/?error=invalid_state");
  }

  // Exchange code for tokens
  const tokenRes = await fetch(`${HYDRA_PUBLIC}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error("Token exchange failed:", err);
    return redirect("/?error=token_exchange_failed");
  }

  const tokens = await tokenRes.json();

  // Fetch user info from the ID token or userinfo endpoint
  let userEmail = "unknown";
  let userName = "Unknown";

  if (tokens.id_token) {
    // Decode JWT payload (no verification needed — Hydra is trusted)
    try {
      const payload = JSON.parse(
        Buffer.from(tokens.id_token.split(".")[1], "base64").toString(),
      );
      userEmail = payload.email || payload.sub || "unknown";
      userName = payload.name || userEmail;
    } catch {
      // Fall back to sub
    }
  }

  // Store in session
  await session?.set("access_token", tokens.access_token);
  await session?.set("refresh_token", tokens.refresh_token);
  await session?.set("user_email", userEmail);
  await session?.set("user_name", userName);
  await session?.set("expires_at",
    tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
  );

  return redirect("/");
};
