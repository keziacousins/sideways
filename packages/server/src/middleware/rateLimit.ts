import { createMiddleware } from "hono/factory";

/**
 * Local IP ranges we treat as "trusted proxies" — only when the request hits
 * us from one of these will we honour the x-real-ip / x-forwarded-for
 * headers. Otherwise we use the actual socket peer address, so a remote
 * client can't forge an arbitrary value to defeat the rate limit.
 *
 * In production the API sits behind nginx on localhost; if you ever expose
 * the API process directly to the Internet, this prevents header-spoofed
 * limit bypass. Add additional ranges (e.g. a CDN's egress) via the
 * TRUSTED_PROXY_IPS env var (comma-separated CIDR or exact IP).
 */
const LOCAL_TRUSTED_IPS = new Set<string>([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

const EXTRA_TRUSTED_IPS = new Set<string>(
  (process.env.TRUSTED_PROXY_IPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

function isTrustedProxy(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return LOCAL_TRUSTED_IPS.has(remoteAddress) || EXTRA_TRUSTED_IPS.has(remoteAddress);
}

function clientIp(c: any): string {
  // The Node adapter exposes the underlying IncomingMessage on c.env.incoming.
  // Hono's wrapped request doesn't have remote-address access on its own.
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  const socketIp = incoming?.socket?.remoteAddress;

  if (isTrustedProxy(socketIp)) {
    const realIp = c.req.header("x-real-ip");
    if (realIp) return realIp;
    const fwd = c.req.header("x-forwarded-for");
    if (fwd) return fwd.split(",")[0].trim();
  }

  return socketIp || "unknown";
}

/**
 * Simple in-memory rate limiter.
 * Tracks hits per key (defaulting to client IP) within a sliding window.
 */
export function rateLimit(opts: { windowMs: number; max: number; keyFn?: (c: any) => string }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // Cleanup expired entries every minute
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now > entry.resetAt) hits.delete(key);
    }
  }, 60_000);

  return createMiddleware(async (c, next) => {
    const key = opts.keyFn?.(c) || clientIp(c);
    const now = Date.now();

    let entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, entry);
    }

    entry.count++;

    if (entry.count > opts.max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      return c.json(
        { error: "Too many requests, please try again later" },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }

    return next();
  });
}
