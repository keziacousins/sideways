import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { type Database, users } from "@sideways/db";

const HYDRA_ADMIN = process.env.HYDRA_ADMIN_URL || "http://localhost:4445";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

/**
 * Auth middleware — validates Bearer token via Hydra introspection.
 * Sets c.get("user") on success. If no token is provided, the request
 * proceeds as anonymous (user will be null).
 */
export function authMiddleware(db: Database) {
  return createMiddleware<{ Variables: { user: AuthUser | null } }>(
    async (c, next) => {
      const authHeader = c.req.header("Authorization");

      if (!authHeader?.startsWith("Bearer ")) {
        c.set("user", null);
        return next();
      }

      const token = authHeader.slice(7);

      try {
        // Introspect the token with Hydra
        const introspectRes = await fetch(
          `${HYDRA_ADMIN}/admin/oauth2/introspect`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ token }),
          },
        );

        if (!introspectRes.ok) {
          c.set("user", null);
          return next();
        }

        const introspection = await introspectRes.json();

        if (!introspection.active) {
          c.set("user", null);
          return next();
        }

        // Look up the user by Hydra subject
        const subject = introspection.sub;
        const user = await db.query.users.findFirst({
          where: eq(users.hydraSubject, subject),
        });

        if (user) {
          c.set("user", {
            id: user.id,
            email: user.email,
            name: user.name,
          });
        } else {
          c.set("user", null);
        }
      } catch {
        c.set("user", null);
      }

      return next();
    },
  );
}

/**
 * Require authentication — returns 401 if no valid user.
 */
export function requireAuth() {
  return createMiddleware<{ Variables: { user: AuthUser | null } }>(
    async (c, next) => {
      const user = c.get("user");
      if (!user) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      return next();
    },
  );
}
