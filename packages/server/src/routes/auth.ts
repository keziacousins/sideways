import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { type Database, users } from "@sideways/db";
import { env } from "../env.js";
import type { AuthUser } from "../middleware/auth.js";

const HYDRA_ADMIN = env.hydraAdminUrl;
const KRATOS_PUBLIC = env.kratosPublicUrl;
const KRATOS_ADMIN = env.kratosAdminUrl;

/** Rewrite Hydra internal URLs to go through our proxy */
function rewriteHydraUrl(url: string): string {
  return url.replace(env.hydraPublicUrl, env.publicApiUrl);
}

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

  /**
   * POST /api/auth/login — Authenticate via Kratos native login flow
   */
  router.post("/login", async (c) => {
    const { email, password } = await c.req.json<{
      email: string;
      password: string;
    }>();

    const flowRes = await fetch(`${KRATOS_PUBLIC}/self-service/login/api`);
    if (!flowRes.ok) {
      return c.json({ error: "Failed to create login flow" }, 500);
    }
    const flow = await flowRes.json();

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

    const nonce = crypto.randomUUID();
    recentLogins.set(nonce, {
      subject,
      expiresAt: Date.now() + 60_000,
    });

    for (const [key, val] of recentLogins) {
      if (val.expiresAt < Date.now()) recentLogins.delete(key);
    }

    return c.json({ nonce });
  });

  /**
   * POST /api/auth/register — Register via Kratos
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

    const nonce = crypto.randomUUID();
    recentLogins.set(nonce, {
      subject,
      expiresAt: Date.now() + 60_000,
    });

    return c.json({ nonce });
  });

  // ── Kratos webhook ───────────────────────────────────────────────────

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

  // ── GET /api/auth/me — Return current user info ──────────────────────

  router.get("/me", async (c) => {
    const user = c.get("user") as AuthUser | null;
    if (!user) return c.json({ error: "Not authenticated" }, 401);
    return c.json({ id: user.id, email: user.email, name: user.name });
  });

  // ── Hydra OAuth2 endpoints ───────────────────────────────────────────

  router.get("/login", async (c) => {
    const challenge = c.req.query("login_challenge");
    if (!challenge) return c.text("Missing login_challenge", 400);

    const loginRequest = await hydraAdmin(
      `/admin/oauth2/auth/requests/login?login_challenge=${challenge}`,
    );

    if (loginRequest.skip) {
      const completion = await hydraAdmin(
        `/admin/oauth2/auth/requests/login/accept?login_challenge=${challenge}`,
        {
          method: "PUT",
          body: JSON.stringify({ subject: loginRequest.subject }),
        },
      );
      return c.redirect(rewriteHydraUrl(completion.redirect_to));
    }

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
        return c.redirect(rewriteHydraUrl(completion.redirect_to));
      }
    }

    return c.redirect(`${env.publicUrl}/auth/login?login_challenge=${challenge}`);
  });

  router.get("/consent", async (c) => {
    const challenge = c.req.query("consent_challenge");
    if (!challenge) return c.text("Missing consent_challenge", 400);

    try {
      const consentRequest = await hydraAdmin(
        `/admin/oauth2/auth/requests/consent?consent_challenge=${challenge}`,
      );

      const subject = consentRequest.subject;

      // Ensure local user exists
      let user = await db.query.users.findFirst({
        where: eq(users.hydraSubject, subject),
      });

      if (!user) {
        try {
          const identityRes = await fetch(
            `${KRATOS_ADMIN}/admin/identities/${subject}`,
          );
          if (identityRes.ok) {
            const identity = await identityRes.json();

            const existingByEmail = await db.query.users.findFirst({
              where: eq(users.email, identity.traits.email),
            });

            if (existingByEmail) {
              await db.update(users)
                .set({ hydraSubject: subject, name: identity.traits.name || existingByEmail.name })
                .where(eq(users.id, existingByEmail.id));
              user = { ...existingByEmail, hydraSubject: subject };
            } else {
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
          }
        } catch (e: any) {
          console.error("[consent] Kratos lookup error:", e.message);
        }
      }

      // Inject claims — these go into the JWT access token
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

      return c.redirect(rewriteHydraUrl(completion.redirect_to));
    } catch (e: any) {
      console.error("Consent error:", e.message);
      return c.text(`Consent failed: ${e.message}`, 500);
    }
  });

  router.get("/logout", async (c) => {
    const challenge = c.req.query("logout_challenge");
    if (!challenge) return c.redirect("/");

    const completion = await hydraAdmin(
      `/admin/oauth2/auth/requests/logout/accept?logout_challenge=${challenge}`,
      { method: "PUT" },
    );

    return c.redirect(rewriteHydraUrl(completion.redirect_to));
  });

  router.get("/authorize", (c) => {
    const nonce = c.req.query("nonce") || "";
    const state = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");

    const authUrl = new URL(`${env.publicApiUrl}/oauth2/auth`);
    authUrl.searchParams.set("client_id", "sideways-web");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "openid offline_access");
    authUrl.searchParams.set("redirect_uri", `${env.publicUrl}/auth/callback`);
    authUrl.searchParams.set("state", state);
    if (nonce) authUrl.searchParams.set("login_hint", nonce);

    return c.redirect(authUrl.toString());
  });

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
