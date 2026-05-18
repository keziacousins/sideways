import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { Buffer } from "node:buffer";
import { createHash, randomBytes, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { type Database, users } from "@sideways/db";
import { env } from "../env.js";
import { sanitiseActorName, type AuthUser } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";

/** Constant-time string compare to avoid leaking byte-by-byte match info. */
function timingSafeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return nodeTimingSafeEqual(aBuf, bBuf);
}

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

/**
 * Hydra now requires PKCE for all public clients (see hydra.yml). The
 * sideways-web client runs its auth flow through these server-side routes,
 * so we generate and store the code_verifier here, keyed by the state
 * parameter — never returning it to the browser.
 */
const pendingPkce = new Map<string, { verifier: string; expiresAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingPkce) if (v.expiresAt < now) pendingPkce.delete(k);
}, 60_000);

function newPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function createAuthRoutes(db: Database) {
  const router = new Hono();

  // Rate limit auth endpoints: 10 requests per minute per IP
  const authRateLimit = rateLimit({ windowMs: 60_000, max: 10 });
  router.use("/login", authRateLimit);
  router.use("/register", authRateLimit);
  router.use("/token", authRateLimit);

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
    // The /api/auth/* prefix is on the public allowlist, so this route must
    // authenticate itself against a shared secret. Kratos is configured to
    // send Authorization: Bearer <KRATOS_WEBHOOK_SECRET>.
    if (!env.kratosWebhookSecret) {
      return c.json({ error: "KRATOS_WEBHOOK_SECRET not configured" }, 500);
    }
    const supplied = c.req.header("authorization");
    const expected = `Bearer ${env.kratosWebhookSecret}`;
    if (!supplied || !timingSafeEqual(supplied, expected)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

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

  /**
   * Scopes we recognise. Any other scope a client requests (including the
   * notorious `claudeai` value that claude.ai sometimes appends — see
   * modelcontextprotocol/modelcontextprotocol#653) is dropped silently
   * before forwarding to Hydra's accept-consent call. Hydra v2.3 has no
   * scope allow-list of its own, so this is the only enforcement point.
   */
  const KNOWN_SCOPES = new Set(["openid", "offline_access", "offline", "mcp"]);

  /**
   * Look up (or auto-create) the Sideways user for a Hydra consent
   * subject. Returns null if Kratos doesn't have the identity either —
   * shouldn't happen in practice but we don't want a 500 if it does.
   * The 409 case (email collision with a different subject) is returned
   * separately so the caller can surface it.
   */
  async function resolveConsentUser(
    subject: string,
  ): Promise<{ user: { id: string; email: string; name: string } | null; conflict?: true }> {
    const user = await db.query.users.findFirst({
      where: eq(users.hydraSubject, subject),
    });
    if (user) return { user };

    try {
      const identityRes = await fetch(`${KRATOS_ADMIN}/admin/identities/${subject}`);
      if (!identityRes.ok) return { user: null };
      const identity = await identityRes.json();

      const existingByEmail = await db.query.users.findFirst({
        where: eq(users.email, identity.traits.email),
      });

      if (existingByEmail) {
        // Refuse to rebind a subject already linked to a different identity
        // — see the longer note in the prior version of this function.
        if (existingByEmail.hydraSubject && existingByEmail.hydraSubject !== subject) {
          console.error(
            "[consent] Refusing to rebind existing user",
            { userId: existingByEmail.id, existing: existingByEmail.hydraSubject, attempted: subject },
          );
          return { user: null, conflict: true };
        }
        await db.update(users)
          .set({ hydraSubject: subject })
          .where(eq(users.id, existingByEmail.id));
        return {
          user: {
            id: existingByEmail.id,
            email: existingByEmail.email,
            name: existingByEmail.name,
          },
        };
      }

      const [created] = await db
        .insert(users)
        .values({
          email: identity.traits.email,
          name: identity.traits.name || identity.traits.email,
          hydraSubject: subject,
        })
        .returning();
      return { user: created };
    } catch (e: any) {
      console.error("[consent] Kratos lookup error:", e.message);
      return { user: null };
    }
  }

  /**
   * Compute the set of access-token audiences we want to grant for a
   * given consent request. claude.ai (and most MCP clients) don't send
   * RFC 8707 resource indicators, so the requested set is usually empty
   * — we add `mcpAudience` based on scope instead, which is the only
   * signal we have that this token is destined for /api/mcp.
   */
  function audiencesForConsent(
    consentRequest: any,
    grantScope: string[],
  ): string[] {
    const requestedAudience: string[] =
      consentRequest.requested_access_token_audience || [];
    const audiences = new Set<string>([env.apiAudience, ...requestedAudience]);
    if (grantScope.includes("mcp")) audiences.add(env.mcpAudience);
    return Array.from(audiences);
  }

  /**
   * DCR'd clients register with audience=[], and Hydra rejects refresh
   * grants for audiences not in the client's allow-list. Patch the
   * client record so the audiences we're about to grant survive the
   * first refresh — otherwise the connector dies 24h after issuance.
   */
  async function ensureClientAudiences(
    client: any,
    requiredAudiences: string[],
  ): Promise<void> {
    const current = new Set<string>(client.audience || []);
    if (requiredAudiences.every((a) => current.has(a))) return;
    const updated = [...new Set([...current, ...requiredAudiences])];
    await hydraAdmin(`/admin/clients/${client.client_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json-patch+json" },
      body: JSON.stringify([
        { op: "replace", path: "/audience", value: updated },
      ]),
    });
  }

  /**
   * Derive the agent identity for a consent request. For OAuth clients
   * with the `mcp` scope, the client_name from DCR becomes the actor —
   * comments and edits get attributed as "Claude via Kezia" etc, the
   * same way API-key actorName works for the CLI. Null if the scope
   * doesn't include mcp or the client_name doesn't sanitise.
   */
  function actorNameForConsent(consentRequest: any, grantScope: string[]): string | null {
    if (!grantScope.includes("mcp")) return null;
    const raw = consentRequest.client?.client_name;
    if (typeof raw !== "string" || !raw) return null;
    return sanitiseActorName(raw);
  }

  /**
   * Build the body for Hydra's accept-consent call. Filters scopes and
   * packs user identity into the access-token session. Audience is
   * passed in so the caller can also patch the client record to match.
   */
  function buildAcceptBody(
    user: { id: string; email: string; name: string } | null,
    grantScope: string[],
    audiences: string[],
    actorName: string | null,
  ) {
    return {
      grant_scope: grantScope,
      grant_access_token_audience: audiences,
      remember: true,
      remember_for: 3600,
      session: {
        access_token: {
          user_id: user?.id,
          email: user?.email,
          name: user?.name,
          ...(actorName ? { actor_name: actorName } : {}),
        },
        id_token: {
          email: user?.email,
          name: user?.name,
        },
      },
    };
  }

  router.get("/consent", async (c) => {
    const challenge = c.req.query("consent_challenge");
    if (!challenge) return c.text("Missing consent_challenge", 400);

    try {
      const consentRequest = await hydraAdmin(
        `/admin/oauth2/auth/requests/consent?consent_challenge=${challenge}`,
      );

      const { user, conflict } = await resolveConsentUser(consentRequest.subject);
      if (conflict) {
        return c.text(
          "An account with this email is already linked to a different identity. " +
          "Contact an administrator to resolve.",
          409,
        );
      }

      // Skip the UI for clients explicitly marked trusted (`skip_consent`
      // on the client record — e.g. sideways-web, sideways-cli) and for
      // remembered grants that Hydra signals via `skip: true`. v2.3
      // doesn't populate `skip` from `client.skip_consent` reliably, so
      // we have to check both.
      const shouldSkipUi = consentRequest.skip || consentRequest.client?.skip_consent;
      if (!shouldSkipUi) {
        return c.redirect(`${env.publicUrl}/auth/consent?consent_challenge=${challenge}`);
      }

      const requestedScopes: string[] = consentRequest.requested_scope || [];
      const grantScope = requestedScopes.filter((s) => KNOWN_SCOPES.has(s));
      const audiences = audiencesForConsent(consentRequest, grantScope);
      const actorName = actorNameForConsent(consentRequest, grantScope);
      await ensureClientAudiences(consentRequest.client, audiences);

      const completion = await hydraAdmin(
        `/admin/oauth2/auth/requests/consent/accept?consent_challenge=${challenge}`,
        {
          method: "PUT",
          body: JSON.stringify(buildAcceptBody(user, grantScope, audiences, actorName)),
        },
      );
      return c.redirect(rewriteHydraUrl(completion.redirect_to));
    } catch (e: any) {
      console.error("Consent error:", e.message);
      return c.text(`Consent failed: ${e.message}`, 500);
    }
  });

  /**
   * GET /api/auth/consent/details — read endpoint for the consent UI.
   * Returns the client and scope summary the page needs to render.
   */
  router.get("/consent/details", async (c) => {
    const challenge = c.req.query("consent_challenge");
    if (!challenge) return c.json({ error: "Missing consent_challenge" }, 400);

    try {
      const consentRequest = await hydraAdmin(
        `/admin/oauth2/auth/requests/consent?consent_challenge=${challenge}`,
      );
      const requestedScopes: string[] = consentRequest.requested_scope || [];
      return c.json({
        client_name: consentRequest.client?.client_name || consentRequest.client?.client_id || "An application",
        client_id: consentRequest.client?.client_id,
        scopes: requestedScopes.filter((s) => KNOWN_SCOPES.has(s)),
        subject_email: consentRequest.context?.email || null,
      });
    } catch (e: any) {
      console.error("Consent details error:", e.message);
      // Hydra returns 404 for unknown / expired / already-handled challenges.
      // Anything else is a server-side problem on our end.
      if (/error 404/.test(e.message)) {
        return c.json(
          { error: "This authorization request is no longer valid. Please start the connection again." },
          404,
        );
      }
      return c.json({ error: "Could not load authorization request." }, 500);
    }
  });

  /**
   * POST /api/auth/consent/decide — write endpoint for the consent UI.
   * Body: { consent_challenge, accept }. Returns { redirect_to } so the
   * UI can send the browser back to Hydra.
   */
  router.post("/consent/decide", async (c) => {
    const body = await c.req.json<{ consent_challenge: string; accept: boolean }>();
    const { consent_challenge: challenge, accept } = body;
    if (!challenge) return c.json({ error: "Missing consent_challenge" }, 400);

    try {
      if (!accept) {
        const completion = await hydraAdmin(
          `/admin/oauth2/auth/requests/consent/reject?consent_challenge=${challenge}`,
          {
            method: "PUT",
            body: JSON.stringify({
              error: "access_denied",
              error_description: "The user declined access.",
            }),
          },
        );
        return c.json({ redirect_to: rewriteHydraUrl(completion.redirect_to) });
      }

      const consentRequest = await hydraAdmin(
        `/admin/oauth2/auth/requests/consent?consent_challenge=${challenge}`,
      );
      const { user, conflict } = await resolveConsentUser(consentRequest.subject);
      if (conflict) {
        return c.json(
          { error: "An account with this email is already linked to a different identity." },
          409,
        );
      }

      const requestedScopes: string[] = consentRequest.requested_scope || [];
      const grantScope = requestedScopes.filter((s) => KNOWN_SCOPES.has(s));
      const audiences = audiencesForConsent(consentRequest, grantScope);
      const actorName = actorNameForConsent(consentRequest, grantScope);
      await ensureClientAudiences(consentRequest.client, audiences);

      const completion = await hydraAdmin(
        `/admin/oauth2/auth/requests/consent/accept?consent_challenge=${challenge}`,
        {
          method: "PUT",
          body: JSON.stringify(buildAcceptBody(user, grantScope, audiences, actorName)),
        },
      );
      return c.json({ redirect_to: rewriteHydraUrl(completion.redirect_to) });
    } catch (e: any) {
      console.error("Consent decide error:", e.message);
      return c.json({ error: e.message }, 500);
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

  router.get("/authorize", async (c) => {
    const nonce = c.req.query("nonce") || "";
    const loginChallenge = c.req.query("login_challenge");

    // If we arrived here while a third-party OAuth flow (e.g. claude.ai)
    // is already in flight, accept its login challenge directly using
    // the Kratos subject we just authenticated. Otherwise the login form
    // would abandon the original flow and start a fresh sideways-web
    // authorize, leaving the connector handshake stranded.
    if (loginChallenge) {
      const recent = recentLogins.get(nonce);
      if (recent && recent.expiresAt > Date.now()) {
        recentLogins.delete(nonce);
        try {
          const completion = await hydraAdmin(
            `/admin/oauth2/auth/requests/login/accept?login_challenge=${loginChallenge}`,
            {
              method: "PUT",
              body: JSON.stringify({
                subject: recent.subject,
                remember: true,
                remember_for: 3600,
              }),
            },
          );
          return c.redirect(rewriteHydraUrl(completion.redirect_to));
        } catch (e: any) {
          console.error("[authorize] login_accept failed:", e.message);
          // Fall through to the sideways-web restart path on error.
        }
      }
    }

    const returnTo = c.req.query("returnTo") || "/";
    const stateRandom = crypto.randomUUID().replace(/-/g, "");
    // Encode returnTo in state so it survives the OAuth redirect chain
    const state = `${stateRandom}:${Buffer.from(returnTo).toString("base64url")}`;

    // PKCE: stash the verifier server-side keyed by state. Hydra is now
    // configured to require PKCE for all public clients (H3); without
    // sending a code_challenge the authorize call would 400.
    const { verifier, challenge } = newPkcePair();
    pendingPkce.set(state, { verifier, expiresAt: Date.now() + 10 * 60_000 });

    const authUrl = new URL(`${env.publicApiUrl}/oauth2/auth`);
    authUrl.searchParams.set("client_id", "sideways-web");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "openid offline_access");
    authUrl.searchParams.set("redirect_uri", `${env.publicUrl}/auth/callback`);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("prompt", "login"); // force fresh login, don't reuse stale sessions
    if (nonce) authUrl.searchParams.set("login_hint", nonce);

    return c.redirect(authUrl.toString());
  });

  router.post("/token", async (c) => {
    const body = await c.req.parseBody();
    const params = new URLSearchParams(body as Record<string, string>);

    // If the caller is the sideways-web flow it sent `state`; look up the
    // PKCE verifier we stored at /authorize time and inject it. DCR'd
    // clients run their own browser-side flow and supply code_verifier
    // themselves — for them, we pass the body through untouched.
    const state = params.get("state");
    if (state) {
      const pending = pendingPkce.get(state);
      if (pending) {
        pendingPkce.delete(state);
        if (!params.has("code_verifier")) {
          params.set("code_verifier", pending.verifier);
        }
      }
      params.delete("state"); // Hydra doesn't accept state on the token endpoint
    }

    const tokenRes = await fetch(`${env.hydraPublicUrl}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });

    const tokens = await tokenRes.json();
    return c.json(tokens, tokenRes.status as any);
  });

  return router;
}
