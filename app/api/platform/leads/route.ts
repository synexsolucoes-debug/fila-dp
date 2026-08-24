import { getD1 } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { PRIVACY_REQUEST_DEADLINE_DAYS } from "@/lib/marketing";
import { ApiError } from "@/lib/api-errors";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";
import { cleanText } from "@/lib/registrations";
import { decodePlatformCursor, encodePlatformCursor, platformListLimit } from "@/lib/platform-console";

export const dynamic = "force-dynamic";

const statuses = ["new", "contacted", "qualified", "discarded"] as const;

/** Contatos do site, visíveis apenas para a administração da plataforma. */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    return await withPlatformContext(platform, async () => {
      const d1 = getD1();
      const url = new URL(request.url);
      const status = cleanText(url.searchParams.get("status"), 20);
      const limit = platformListLimit(url.searchParams.get("limit"));
      const cursor = decodePlatformCursor(url.searchParams.get("cursor"));
      const filters = ["1 = 1"];
      const values: unknown[] = [];
      if (status && statuses.includes(status as typeof statuses[number])) { filters.push("status = ?"); values.push(status); }
      if (cursor) { filters.push("(created_at < ?::timestamptz OR (created_at = ?::timestamptz AND id < ?))"); values.push(cursor.createdAt, cursor.createdAt, cursor.id); }
      const [leads, totals, privacidade] = await Promise.all([
        d1.prepare(`SELECT id, name, email, company, phone, headcount, interest, message, status, source_path, handled_at, created_at
          FROM fdp_marketing_leads WHERE ${filters.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`).bind(...values, limit + 1).all<Record<string, unknown>>(),
        d1.prepare("SELECT status, count(*)::int AS total FROM fdp_marketing_leads GROUP BY status").all<{ status: string; total: number }>(),
        // Pedidos de titular em aberto, com o mais antigo.
        //
        // A página de privacidade promete resposta em até 15 dias e manda o
        // titular usar este formulário. Sem esta conta, o pedido ficava
        // indistinguível de um contato comercial numa lista chamada "Leads
        // comerciais", e o prazo corria sem nada marcá-lo.
        // A idade sai calculada do banco, não do relógio do navegador: o
        // servidor é quem sabe a hora de referência, e contar dias durante a
        // renderização torna o componente impuro.
        d1.prepare(`SELECT count(*)::int AS abertos,
            COALESCE(EXTRACT(DAY FROM now() - min(created_at))::int, 0) AS dias_do_mais_antigo
          FROM fdp_marketing_leads
          WHERE interest = 'privacidade' AND status IN ('new', 'contacted')`)
          .all<{ abertos: number; dias_do_mais_antigo: number }>(),
      ]);
      const page = leads.results.slice(0, limit);
      const next = leads.results.length > limit ? page.at(-1) : null;
      return Response.json({
        leads: page,
        nextCursor: encodePlatformCursor(next ? { createdAt: String(next.created_at), id: String(next.id) } : null),
        totals: Object.fromEntries(totals.results.map((row) => [String(row.status), Number(row.total)])),
        privacyRequests: {
          open: Number(privacidade.results[0]?.abertos ?? 0),
          oldestDays: Number(privacidade.results[0]?.dias_do_mais_antigo ?? 0),
          deadlineDays: PRIVACY_REQUEST_DEADLINE_DAYS,
        },
      });
    });
  } catch (error) {
    return apiError(error);
  }
}

/** Marca o andamento do contato; o histórico de quem tratou fica registrado. */
export async function PATCH(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user);
    const body = await request.json() as Record<string, unknown>;
    const id = cleanText(body.id, 120);
    const status = cleanText(body.status, 20);
    if (!id || !statuses.includes(status as typeof statuses[number])) {
      throw ApiError.badRequest("Informe o contato e um status válido.", "LEAD_STATUS_INVALID");
    }
    return await withPlatformContext(platform, async () => {
      const d1 = getD1();
      const before = await d1.prepare("SELECT id, status FROM fdp_marketing_leads WHERE id = ?").bind(id).first<{ id: string; status: string }>();
      if (!before) throw ApiError.notFound("Contato não encontrado.", "LEAD_NOT_FOUND");
      const updated = await d1.prepare(`UPDATE fdp_marketing_leads SET status = ?, handled_by = ?, handled_at = now()
        WHERE id = ? RETURNING id, status`).bind(status, platform.userId, id).first<{ id: string; status: string }>();
      if (!updated) throw ApiError.notFound("Contato não encontrado.", "LEAD_NOT_FOUND");

      await d1.prepare(`INSERT INTO fdp_platform_audit_events (id, actor_user_id, actor_email, action, entity_type, entity_id, before_json, after_json, request_id)
        VALUES (?, ?, ?, 'marketing_lead.updated', 'marketing_lead', ?, ?::jsonb, ?::jsonb, ?)`)
        .bind(crypto.randomUUID(), platform.userId, auth.user.email, id, JSON.stringify({ status: before.status }), JSON.stringify({ status }), request.headers.get("x-fila-dp-request-id") ?? "")
        .run();

      return Response.json({ lead: updated });
    });
  } catch (error) {
    return apiError(error);
  }
}
