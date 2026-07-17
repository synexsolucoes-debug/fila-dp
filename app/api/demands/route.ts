import { desc } from "drizzle-orm";
import { getDb } from "../../../db";
import { demandHistory, demands } from "../../../db/schema";
import { ensureCurrentUser } from "../../../lib/current-user";

const categories = new Set(["Admissão", "Férias", "Rescisão", "Ponto", "Folha", "Benefícios", "Afastamento", "eSocial", "Atendimento", "Outros"]);
const sources = new Set(["E-mail", "WhatsApp", "Verbal"]);
const priorities = new Set(["low", "medium", "high", "urgent"]);

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Erro inesperado";
  if (message.includes("no such table")) return "O banco de dados ainda está sendo preparado. Tente novamente em instantes.";
  return message;
}

export async function GET() {
  try {
    const user = await ensureCurrentUser();
    const db = getDb();
    const rows = await db.select().from(demands).orderBy(desc(demands.createdAt), desc(demands.id));
    return Response.json({ demands: rows, user: { name: user.displayName, email: user.email, role: user.role } });
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await ensureCurrentUser();
    const payload = (await request.json()) as Record<string, unknown>;
    const category = String(payload.category ?? "").trim();
    const company = String(payload.company ?? "").trim();
    const employee = String(payload.employee ?? "").trim();
    const requester = String(payload.requester ?? "").trim();
    const source = String(payload.source ?? "");
    const priority = String(payload.priority ?? "medium");
    const dueDate = String(payload.dueDate ?? "");
    const description = String(payload.description ?? "").trim();

    if (!categories.has(category) || !company || !requester || !sources.has(source) || !priorities.has(priority) || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      return Response.json({ error: "Revise os campos obrigatórios da demanda." }, { status: 400 });
    }

    const title = `${category} – ${employee || company}`;
    const db = getDb();
    const [demand] = await db.insert(demands).values({
      title,
      description,
      category,
      company,
      employee: employee || null,
      requester,
      source: source as "E-mail" | "WhatsApp" | "Verbal",
      priority: priority as "low" | "medium" | "high" | "urgent",
      dueDate,
      createdByEmail: user.email,
    }).returning();

    await db.insert(demandHistory).values({
      demandId: demand.id,
      action: "created",
      details: `Demanda cadastrada via ${source}`,
      userEmail: user.email,
      userName: user.displayName,
    });

    return Response.json({ demand }, { status: 201 });
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 500 });
  }
}
