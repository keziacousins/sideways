import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import node from "@astrojs/node";

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [react()],
  server: { port: 4000 },
  // CSRF protection lives in src/middleware.ts (proxy-aware check against
  // PUBLIC_URL). Astro's built-in `checkOrigin` compares Origin to the
  // internal Host/scheme it sees, which behind an HTTPS-terminating proxy
  // is always http://localhost:4000 — guaranteed to mismatch the public
  // https Origin. See middleware.ts for the working equivalent.
  security: { checkOrigin: false },
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
