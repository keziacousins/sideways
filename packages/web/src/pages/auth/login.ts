import type { APIRoute } from "astro";
import { randomBytes } from "node:crypto";

const HYDRA_PUBLIC = import.meta.env.HYDRA_PUBLIC_URL || "http://localhost:4444";
const CLIENT_ID = "sideways-web";

/**
 * Initiates the OAuth2 authorization code flow.
 * Redirects the user to Hydra's authorize endpoint.
 */
export const GET: APIRoute = async ({ redirect, session }) => {
  const state = randomBytes(16).toString("hex");

  // Store state in session for CSRF validation on callback
  await session?.set("oauth_state", state);

  const authUrl = new URL(`${HYDRA_PUBLIC}/oauth2/auth`);
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid offline_access profile email");
  authUrl.searchParams.set("redirect_uri", "http://localhost:4000/auth/callback");
  authUrl.searchParams.set("state", state);

  return redirect(authUrl.toString());
};
