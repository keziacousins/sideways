import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { type Database, users } from "@sideways/db";

const HYDRA_ADMIN = process.env.HYDRA_ADMIN_URL || "http://localhost:4445";

async function hydraAdmin(path: string, options?: RequestInit) {
  const res = await fetch(`${HYDRA_ADMIN}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Hydra admin error ${res.status}: ${text}`);
  }
  return res.json();
}

export function createAuthRoutes(db: Database) {
  const router = new Hono();

  /**
   * Login endpoint — Hydra redirects here during OAuth2 authorization.
   * For dev: auto-creates/finds a user by email and accepts the login.
   * In production, this would render a login form.
   */
  router.get("/login", async (c) => {
    const challenge = c.req.query("login_challenge");
    if (!challenge) return c.text("Missing login_challenge", 400);

    // Get the login request from Hydra
    const loginRequest = await hydraAdmin(
      `/admin/oauth2/auth/requests/login?login_challenge=${challenge}`,
    );

    // If the user is already authenticated, skip the login
    if (loginRequest.skip) {
      const completion = await hydraAdmin(
        `/admin/oauth2/auth/requests/login/accept?login_challenge=${challenge}`,
        {
          method: "PUT",
          body: JSON.stringify({ subject: loginRequest.subject }),
        },
      );
      return c.redirect(completion.redirect_to);
    }

    // For dev: show a minimal login form
    const html = `<!DOCTYPE html>
<html><head><title>Sideways Login</title>
<style>
  body { font-family: system-ui; max-width: 400px; margin: 4rem auto; padding: 0 1rem; }
  input, button { display: block; width: 100%; padding: 0.75rem; margin: 0.5rem 0; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 1rem; box-sizing: border-box; }
  button { background: #6366f1; color: white; border: none; cursor: pointer; }
  button:hover { background: #4f46e5; }
  h1 { font-size: 1.5rem; }
</style></head>
<body>
  <h1>Sign in to Sideways</h1>
  <form method="POST" action="/auth/login?login_challenge=${challenge}">
    <input type="email" name="email" placeholder="Email" required autofocus />
    <input type="text" name="name" placeholder="Name" required />
    <button type="submit">Sign in</button>
  </form>
</body></html>`;
    return c.html(html);
  });

  router.post("/login", async (c) => {
    const challenge = c.req.query("login_challenge");
    if (!challenge) return c.text("Missing login_challenge", 400);

    const form = await c.req.parseBody();
    const email = String(form.email);
    const name = String(form.name);

    // Find or create user
    let user = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (!user) {
      const [created] = await db
        .insert(users)
        .values({ email, name, hydraSubject: email })
        .returning();
      user = created;
    } else if (!user.hydraSubject) {
      await db
        .update(users)
        .set({ hydraSubject: email })
        .where(eq(users.id, user.id));
    }

    // Accept the login
    const completion = await hydraAdmin(
      `/admin/oauth2/auth/requests/login/accept?login_challenge=${challenge}`,
      {
        method: "PUT",
        body: JSON.stringify({
          subject: email,
          remember: true,
          remember_for: 3600,
        }),
      },
    );

    return c.redirect(completion.redirect_to);
  });

  /**
   * Consent endpoint — Hydra redirects here after login.
   * Auto-accepts all requested scopes for dev. In production,
   * this would show a consent screen.
   */
  router.get("/consent", async (c) => {
    const challenge = c.req.query("consent_challenge");
    if (!challenge) return c.text("Missing consent_challenge", 400);

    const consentRequest = await hydraAdmin(
      `/admin/oauth2/auth/requests/consent?consent_challenge=${challenge}`,
    );

    // Auto-accept all scopes in dev
    const completion = await hydraAdmin(
      `/admin/oauth2/auth/requests/consent/accept?consent_challenge=${challenge}`,
      {
        method: "PUT",
        body: JSON.stringify({
          grant_scope: consentRequest.requested_scope,
          grant_access_token_audience:
            consentRequest.requested_access_token_audience,
          remember: true,
          remember_for: 3600,
          session: {
            id_token: {
              email: consentRequest.subject,
            },
          },
        }),
      },
    );

    return c.redirect(completion.redirect_to);
  });

  /**
   * Logout endpoint
   */
  router.get("/logout", async (c) => {
    const challenge = c.req.query("logout_challenge");
    if (!challenge) return c.redirect("/");

    const completion = await hydraAdmin(
      `/admin/oauth2/auth/requests/logout/accept?logout_challenge=${challenge}`,
      { method: "PUT" },
    );

    return c.redirect(completion.redirect_to);
  });

  /**
   * OAuth2 callback — exchanges code for tokens.
   * Used by the web app after Hydra redirects back.
   */
  router.get("/callback", async (c) => {
    const code = c.req.query("code");
    if (!code) return c.text("Missing code", 400);

    const tokenRes = await fetch(
      `${process.env.HYDRA_PUBLIC_URL || "http://localhost:4444"}/oauth2/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://localhost:4000/auth/callback",
          client_id: "sideways-web",
          client_secret: process.env.HYDRA_CLIENT_SECRET || "znuld0L9Z6hKYSwcjYr0uSm5ll",
        }),
      },
    );

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return c.text(`Token exchange failed: ${err}`, 500);
    }

    const tokens = await tokenRes.json();

    // For now, return the tokens. In production, set a session cookie.
    return c.json({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      id_token: tokens.id_token,
      expires_in: tokens.expires_in,
    });
  });

  return router;
}
