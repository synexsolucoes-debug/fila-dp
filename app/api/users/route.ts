import { asc } from "drizzle-orm";
import { getDb } from "../../../db";
import { users } from "../../../db/schema";
import { ensureCurrentUser } from "../../../lib/current-user";

export async function GET() {
  try {
    const currentUser = await ensureCurrentUser();
    const db = getDb();
    const rows = currentUser.role === "admin"
      ? await db.select().from(users).orderBy(asc(users.displayName))
      : [currentUser];
    return Response.json({ users: rows, currentUser });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro inesperado";
    return Response.json({ error: message }, { status: 500 });
  }
}
