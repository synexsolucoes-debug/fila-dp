import { count, eq } from "drizzle-orm";
import { getChatGPTUser } from "../app/chatgpt-auth";
import { getDb } from "../db";
import { users } from "../db/schema";

export async function ensureCurrentUser() {
  const authenticated = await getChatGPTUser();
  const identity = authenticated ?? {
    displayName: "Rian Oliveira",
    email: "rian@filadp.local",
  };

  const db = getDb();
  const [existing] = await db.select().from(users).where(eq(users.email, identity.email)).limit(1);
  if (existing) {
    if (existing.displayName !== identity.displayName) {
      const [updated] = await db.update(users)
        .set({ displayName: identity.displayName })
        .where(eq(users.id, existing.id))
        .returning();
      return updated;
    }
    return existing;
  }

  const [{ total }] = await db.select({ total: count() }).from(users);
  const [created] = await db.insert(users).values({
    email: identity.email,
    displayName: identity.displayName,
    role: total === 0 ? "admin" : "analyst",
  }).returning();
  return created;
}
