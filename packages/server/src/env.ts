export const env = {
  port: Number(process.env.PORT) || 4100,

  // Public-facing URLs (what the browser sees)
  publicUrl: process.env.PUBLIC_URL || "http://localhost:4000",
  publicApiUrl: process.env.PUBLIC_API_URL || "http://localhost:4100",

  // Internal service URLs (server-to-server)
  databaseUrl:
    process.env.DATABASE_URL ||
    (() => { throw new Error("DATABASE_URL must be set"); })(),
  seaweedFilerUrl:
    process.env.SEAWEEDFS_FILER_URL || "http://localhost:8888",
  hydraPublicUrl:
    process.env.HYDRA_PUBLIC_URL || "http://localhost:4444",
  // JWT issuer — must match URLS_SELF_ISSUER in Hydra config
  hydraIssuerUrl:
    process.env.HYDRA_ISSUER_URL || process.env.PUBLIC_API_URL || "http://localhost:4100",
  hydraAdminUrl:
    process.env.HYDRA_ADMIN_URL || "http://localhost:4445",
  kratosPublicUrl:
    process.env.KRATOS_PUBLIC_URL || "http://localhost:4433",
  kratosAdminUrl:
    process.env.KRATOS_ADMIN_URL || "http://localhost:4434",
  weasyPrintUrl:
    process.env.WEASYPRINT_URL || "http://localhost:5001",

  /**
   * Required audience claim on JWT access tokens. The consent route forces
   * this into grant_access_token_audience and the auth middleware rejects
   * tokens that don't carry it. Override only if you've reconfigured the
   * Hydra client audience to something else.
   */
  apiAudience: process.env.API_AUDIENCE || "sideways-api",

  /**
   * Audience claim on JWTs issued to MCP OAuth clients (claude.ai etc).
   * Distinct from apiAudience so MCP tokens are identifiable in logs and
   * can be policy-gated separately later. The consent endpoint injects
   * this audience when the requested scopes include `mcp`, and the MCP
   * route validates against it.
   */
  mcpAudience: process.env.MCP_AUDIENCE || "sideways-mcp",

  /**
   * Shared secret authenticating Kratos → /api/auth/hooks/registration.
   * Kratos sends this in the Authorization header (configured in compose.yml).
   * Required in production; the dev default is intentionally insecure so a
   * missing secret fails loudly.
   */
  kratosWebhookSecret: process.env.KRATOS_WEBHOOK_SECRET || "",

  /**
   * Additional CORS origins beyond the public/dev defaults.
   * Comma-separated list of exact origins (scheme + host [+ port], no path).
   * e.g. CORS_ORIGINS="https://docs.example.com,https://staging.example.com"
   */
  corsOrigins: (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};
