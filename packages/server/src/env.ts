export const env = {
  port: Number(process.env.PORT) || 4100,
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://sideways:sideways@localhost:5432/sideways",
  seaweedFilerUrl:
    process.env.SEAWEEDFS_FILER_URL || "http://localhost:8888",
};
