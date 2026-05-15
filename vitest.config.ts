import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
    exclude: ["**/node_modules/**", "**/references/**", "**/dist/**", "**/e2e/**"],
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ||
        "postgres://sideways:sideways@localhost:5432/sideways_test",
      SEAWEEDFS_FILER_URL:
        process.env.TEST_SEAWEEDFS_FILER_URL || "http://localhost:8888",
      TEST_API_URL: "http://localhost:4100",
      // Bearer secret for the Kratos registration webhook. Tests pass
      // `Authorization: Bearer ${KRATOS_WEBHOOK_SECRET}` in the request;
      // the route's check uses `env.kratosWebhookSecret` (sourced from
      // process.env in env.ts), so any non-empty value works here.
      KRATOS_WEBHOOK_SECRET: "test-webhook-secret",
    },
    globalSetup: "./vitest.global-setup.ts",
  },
});
