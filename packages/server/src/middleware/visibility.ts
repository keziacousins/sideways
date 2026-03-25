import { eq } from "drizzle-orm";
import { type Database, spaces, spaceMembers } from "@sideways/db";
import type { AuthUser } from "./auth.js";

/**
 * Check if a user can access a space based on its visibility.
 *
 * - public: anyone
 * - org: any authenticated user
 * - shared: space owner or explicit member
 * - private: space owner only
 */
export async function canAccessSpace(
  db: Database,
  spaceId: string,
  visibility: string,
  ownerId: string,
  user: AuthUser | null,
): Promise<boolean> {
  if (visibility === "public") return true;
  if (!user) return false;
  if (visibility === "org") return true;
  if (user.id === ownerId) return true;

  // Check membership for "shared" visibility
  if (visibility === "shared") {
    const member = await db.query.spaceMembers.findFirst({
      where: (m, { and, eq }) =>
        and(eq(m.spaceId, spaceId), eq(m.userId, user.id)),
    });
    return !!member;
  }

  return false;
}

/**
 * Check if a user can write to a space.
 * Owner or editor/admin members can write.
 */
export async function canWriteSpace(
  db: Database,
  spaceId: string,
  ownerId: string,
  user: AuthUser | null,
): Promise<boolean> {
  if (!user) return false;
  if (user.id === ownerId) return true;

  const member = await db.query.spaceMembers.findFirst({
    where: (m, { and, eq }) =>
      and(eq(m.spaceId, spaceId), eq(m.userId, user.id)),
  });

  return !!member && (member.role === "editor" || member.role === "admin");
}
