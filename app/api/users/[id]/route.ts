import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { users } from "../../../../db/schema";
import { ensureCurrentUser } from "../../../../lib/current-user";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const currentUser = await ensureCurrentUser();
    if (currentUser.role !== "admin") return Response.json({ error: "Acesso restrito ao administrador." }, { status: 403 });
    const { id: rawId } = await context.params;
    const id = Number(rawId);
    const payload = (await request.json()) as { role?: string };
    if (!Number.isInteger(id) || !["admin", "analyst"].includes(payload.role ?? "")) return Response.json({ error: "Dados inválidos." }, { status: 400 });
    if (id === currentUser.id && payload.role !== "admin") return Response.json({ error: "Você não pode remover seu próprio acesso administrativo." }, { status: 400 });
    const db = getDb();
    const [user] = await db.update(users).set({ role: payload.role as "admin" | "analyst" }).where(eq(users.id, id)).returning();
    if (!user) return Response.json({ error: "Usuário não encontrado." }, { status: 404 });
    return Response.json({ user });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro inesperado";
    return Response.json({ error: message }, { status: 500 });
  }
}
