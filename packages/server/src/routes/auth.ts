import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { type Database, users } from "@sideways/db";
import { env } from "../env.js";

const HYDRA_ADMIN = env.hydraAdminUrl;
const KRATOS_PUBLIC = env.kratosPublicUrl;
const KRATOS_ADMIN = env.kratosAdminUrl;

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

/** Map to store recent Kratos login nonces for the OAuth2 bridge */
const recentLogins = new Map<string, { subject: string; expiresAt: number }>();

export function createAuthRoutes(db: Database) {
  const router = new Hono();

  // ── Kratos proxy routes ──────────────────────────────────────────────
  // These proxy to Kratos native API so the frontend doesn't need
  // direct CORS access to Kratos.

  /**
   * POST /auth/login — Authenticate via Kratos native login flow
   * Body: { email, password }
   * Returns: { nonce } on success (used to bridge to OAuth2 flow)
   */
  router.post("/login", async (c) => {
    const { email, password } = await c.req.json<{
      email: string;
      password: string;
    }>();

    // Create a native login flow
    const flowRes = await fetch(`${KRATOS_PUBLIC}/self-service/login/api`, {
      method: "GET",
    });
    if (!flowRes.ok) {
      return c.json({ error: "Failed to create login flow" }, 500);
    }
    const flow = await flowRes.json();

    // Submit credentials
    const submitRes = await fetch(
      `${KRATOS_PUBLIC}/self-service/login?flow=${flow.id}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "password",
          identifier: email,
          password,
        }),
      },
    );

    if (!submitRes.ok) {
      const err = await submitRes.json();
      const message =
        err.ui?.messages?.[0]?.text ||
        err.ui?.nodes?.find((n: any) =>
          n.messages?.some((m: any) => m.type === "error"),
        )?.messages?.[0]?.text ||
        "Invalid credentials";
      return c.json({ error: message }, 401);
    }

    const session = await submitRes.json();
    const subject = session.session?.identity?.id || session.identity?.id;

    if (!subject) {
      return c.json({ error: "Login failed: no identity" }, 500);
    }

    // Generate a nonce and store it for the OAuth2 bridge
    const nonce = crypto.randomUUID();
    recentLogins.set(nonce, {
      subject,
      expiresAt: Date.now() + 60_000, // 1 minute
    });

    // Clean up expired nonces
    for (const [key, val] of recentLogins) {
      if (val.expiresAt < Date.now()) recentLogins.delete(key);
    }

    return c.json({ nonce });
  });

  /**
   * POST /auth/register — Register via Kratos native registration flow
   * Body: { email, name, password }
   */
  router.post("/register", async (c) => {
    const { email, name, password } = await c.req.json<{
      email: string;
      name: string;
      password: string;
    }>();

    const flowRes = await fetch(
      `${KRATOS_PUBLIC}/self-service/registration/api`,
    );
    if (!flowRes.ok) {
      return c.json({ error: "Failed to create registration flow" }, 500);
    }
    const flow = await flowRes.json();

    const submitRes = await fetch(
      `${KRATOS_PUBLIC}/self-service/registration?flow=${flow.id}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "password",
          traits: { email, name },
          password,
        }),
      },
    );

    if (!submitRes.ok) {
      const err = await submitRes.json();
      const message =
        err.ui?.messages?.[0]?.text ||
        err.ui?.nodes?.find((n: any) =>
          n.messages?.some((m: any) => m.type === "error"),
        )?.messages?.[0]?.text ||
        "Registration failed";
      return c.json({ error: message }, 400);
    }

    const result = await submitRes.json();
    const subject = result.identity?.id;

    if (!subject) {
      return c.json({ error: "Registration succeeded but no identity returned" }, 500);
    }

    // Generate nonce for immediate OAuth2 login
    const nonce = crypto.randomUUID();
    recentLogins.set(nonce, {
      subject,
      expiresAt: Date.now() + 60_000,
    });

    return c.json({ nonce });
  });

  // ── Kratos webhook ───────────────────────────────────────────────────

  /**
   * POST /auth/hooks/registration — Called by Kratos after registration
   * Creates/updates the local user record.
   */
  router.post("/hooks/registration", async (c) => {
    const body = await c.req.json<{
      identity_id: string;
      email: string;
      name: string;
    }>();

    const existing = await db.query.users.findFirst({
      where: eq(users.hydraSubject, body.identity_id),
    });

    if (!existing) {
      await db.insert(users).values({
        email: body.email,
        name: body.name,
        hydraSubject: body.identity_id,
      });
    }

    return c.json({ ok: true });
  });

  // ── Hydra OAuth2 endpoints ───────────────────────────────────────────
  // These are called by Hydra during the authorization flow.

  /**
   * GET /auth/login — Hydra redirects here for login.
   * If we have a valid nonce (from Kratos login), auto-accept.
   * Otherwise redirect to the web login page.
   */
  router.get("/login", async (c) => {
    const challenge = c.req.query("login_challenge");
    if (!challenge) return c.text("Missing login_challenge", 400);

    const loginRequest = await hydraAdmin(
      `/admin/oauth2/auth/requests/login?login_challenge=${challenge}`,
    );

    // Already authenticated — skip
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

    // Check if login_hint contains a valid nonce
    const hint = loginRequest.oidc_context?.login_hint;
    if (hint && recentLogins.has(hint)) {
      const login = recentLogins.get(hint)!;
      recentLogins.delete(hint);

      if (login.expiresAt > Date.now()) {
        const completion = await hydraAdmin(
          `/admin/oauth2/auth/requests/login/accept?login_challenge=${challenge}`,
          {
            method: "PUT",
            body: JSON.stringify({
              subject: login.subject,
              remember: true,
              remember_for: 3600,
            }),
          },
        );
        return c.redirect(completion.redirect_to);
      }
    }

    // No valid nonce — redirect to web login page
    return c.redirect(`http://localhost:4000/auth/login?login_challenge=${challenge}`);
  });

  /**
   * GET /auth/consent — Hydra redirects here after login.
   * Auto-accepts all scopes (first-party app).
   * Injects custom claims into the JWT.
   */
  router.get("/consent", async (c) => {
    const challenge = c.req.query("consent_challenge");
    if (!challenge) return c.text("Missing consent_challenge", 400);

    const consentRequest = await hydraAdmin(
      `/admin/oauth2/auth/requests/consent?consent_challenge=${challenge}`,
    );

    const subject = consentRequest.subject;

    // Look up or create local user
    let user = await db.query.users.findFirst({
      where: eq(users.hydraSubject, subject),
    });

    if (!user) {
      // Fetch identity from Kratos to get traits
      try {
        const identityRes = await fetch(
          `${KRATOS_ADMIN}/admin/identities/${subject}`,
        );
        if (identityRes.ok) {
          const identity = await identityRes.json();
          const [created] = await db
            .insert(users)
            .values({
              email: identity.traits.email,
              name: identity.traits.name || identity.traits.email,
              hydraSubject: subject,
            })
            .returning();
          user = created;
        }
      } catch {
        // Fall through — user might not exist yet
      }
    }

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
            access_token: {
              user_id: user?.id,
              email: user?.email,
              name: user?.name,
            },
            id_token: {
              email: user?.email,
              name: user?.name,
            },
          },
        }),
      },
    );

    return c.redirect(completion.redirect_to);
  });

  /**
   * GET /auth/logout — Hydra logout endpoint
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
   * POST /auth/token — Proxy token exchange to Hydra
   * Used by the web frontend after OAuth2 callback.
   */
  router.post("/token", async (c) => {
    const body = await c.req.parseBody();

    const tokenRes = await fetch(`${env.hydraPublicUrl}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body as Record<string, string>),
    });

    const tokens = await tokenRes.json();
    return c.json(tokens, tokenRes.status as any);
  });

  return router;
}
