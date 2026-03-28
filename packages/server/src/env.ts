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
};
