import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import node from "@astrojs/node";

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [react()],
  server: { port: 4000 },
  // CSRF protection: refuse POST/PUT/PATCH/DELETE when the Origin header
  // doesn't match the host. Astro's built-in check; combined with the
  // SameSite=Lax session cookie this closes most browser-driven CSRF paths.
  security: { checkOrigin: true },
  session: {
    driver: "fs",
    options: {
      base: "/var/lib/sideways/sessions",
    },
    cookie: {
      name: "sw-session",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
    ttl: 7 * 24 * 60 * 60, // 7 days
  },
});
