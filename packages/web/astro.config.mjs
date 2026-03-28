import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import node from "@astrojs/node";

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [react()],
  server: { port: 4000 },
  security: { checkOrigin: false },
  session: {
    driver: "fs",
    options: {
      base: "/var/lib/sideways/sessions",
    },
    cookie: {
      name: "sw-session",
      sameSite: "lax",
      secure: true,
    },
    ttl: 7 * 24 * 60 * 60, // 7 days
  },
});
