import { createMiddleware } from "hono/factory";

/**
 * Simple in-memory rate limiter.
 * Tracks hits per key (IP) within a sliding window.
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
    const key = opts.keyFn?.(c) || c.req.header("x-real-ip") || c.req.header("x-forwarded-for")?.split(",")[0] || "unknown";
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
