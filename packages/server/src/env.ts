export const env = {
  port: Number(process.env.PORT) || 4100,
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://sideways:sideways@localhost:5432/sideways",
  seaweedFilerUrl:
    process.env.SEAWEEDFS_FILER_URL || "http://localhost:8888",
  hydraPublicUrl:
    process.env.HYDRA_PUBLIC_URL || "http://localhost:4444",
  hydraAdminUrl:
    process.env.HYDRA_ADMIN_URL || "http://localhost:4445",
  kratosPublicUrl:
    process.env.KRATOS_PUBLIC_URL || "http://localhost:4433",
  kratosAdminUrl:
    process.env.KRATOS_ADMIN_URL || "http://localhost:4434",
};
