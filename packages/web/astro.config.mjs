import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import node from "@astrojs/node";

// Session file storage path. systemd creates the prod dir via StateDirectory=
// in the sideways-web.service unit (see scripts/setup-vm.sh). The path here
// MUST match `/var/lib/sideways/sessions` exactly and MUST flow through the
// Astro 6 driver-object form below — the legacy `driver: "fs"` + `options: {...}`
// shape silently drops `options.base` and writes to `.astro/session` inside
// the build dir, which `astro build` + rsync deploys clobber. That regression
// shipped silently and logged everyone out on every deploy until 1.4.2.
// `packages/web/src/middleware.ts` runs a startup check on this path.
const SESSION_BASE =
  process.env.NODE_ENV === "production"
    ? "/var/lib/sideways/sessions"
    : ".astro/session";

// How long a session survives without use, in seconds. One number for both
// the stored data and the cookie: with no `maxAge` the cookie is dropped
// when the browser quits, however long the data behind it would have lasted.
// The window slides — the middleware rewrites the session on each token
// refresh, which also reissues the cookie.
const SESSION_TTL = 7 * 24 * 60 * 60; // 7 days

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
    driver: {
      entrypoint: "unstorage/drivers/fs-lite",
      config: { base: SESSION_BASE },
    },
    cookie: {
      name: "sw-session",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: SESSION_TTL,
    },
    ttl: SESSION_TTL,
  },
});
