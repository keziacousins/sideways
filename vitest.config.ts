import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
    exclude: ["**/node_modules/**", "**/references/**", "**/dist/**"],
    env: {
      DATABASE_URL:
        "postgres://sideways:sideways@localhost:5432/sideways_test",
      SEAWEEDFS_FILER_URL: "http://localhost:8888",
      TEST_API_URL: "http://localhost:4100",
    },
    globalSetup: "./vitest.global-setup.ts",
  },
});
