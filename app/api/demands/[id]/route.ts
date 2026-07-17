import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../../db";
import { demandHistory, demands } from "../../../../db/schema";
import { ensureCurrentUser } from "../../../../lib/current-user";

const statuses = new Set(["available", "in_progress", "waiting", "done"]);

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await ensureCurrentUser();
    const { id: rawId } = await context.params;
    const id = Number(rawId);
    const payload = (await request.json()) as { action?: string; status?: string };
    if (!Number.isInteger(id)) return Response.json({ error: "Demanda inválida." }, { status: 400 });

    const db = getDb();
    const [existing] = await db.select().from(demands).where(eq(demands.id, id)).limit(1);
    if (!existing) return Response.json({ error: "Demanda não encontrada." }, { status: 404 });

    if (payload.action === "claim") {
      const [updated] = await db.update(demands).set({
        status: "in_progress",
        assigneeEmail: user.email,
        assignee: user.displayName,
        updatedAt: new Date().toISOString(),
      }).where(and(eq(demands.id, id), isNull(demands.assigneeEmail), eq(demands.status, "available"))).returning();

      if (!updated) return Response.json({ error: "Outro analista assumiu esta demanda primeiro." }, { status: 409 });
      await db.insert(demandHistory).values({ demandId: id, action: "claimed", details: "Demanda assumida", userEmail: user.email, userName: user.displayName });
      return Response.json({ demand: updated });
    }

    if (payload.action === "move" && payload.status && statuses.has(payload.status)) {
      if (existing.assigneeEmail && existing.assigneeEmail !== user.email && user.role !== "admin") {
        return Response.json({ error: "Somente o responsável ou um administrador pode movimentar esta demanda." }, { status: 403 });
      }
      const status = payload.status as "available" | "in_progress" | "waiting" | "done";
      const [updated] = await db.update(demands).set({
        status,
        assigneeEmail: status === "available" ? null : (existing.assigneeEmail ?? user.email),
        assignee: status === "available" ? null : (existing.assignee ?? user.displayName),
        updatedAt: new Date().toISOString(),
      }).where(eq(demands.id, id)).returning();
      await db.insert(demandHistory).values({ demandId: id, action: "status_changed", details: `Status alterado para ${status}`, userEmail: user.email, userName: user.displayName });
      return Response.json({ demand: updated });
    }

    return Response.json({ error: "Ação inválida." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro inesperado";
    return Response.json({ error: message }, { status: 500 });
  }
}
