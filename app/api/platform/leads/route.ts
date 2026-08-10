import { getD1 } from "@/db";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { ApiError } from "@/lib/api-errors";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";
import { cleanText } from "@/lib/registrations";

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
      const status = cleanText(new URL(request.url).searchParams.get("status"), 20);
      const where = status && statuses.includes(status as typeof statuses[number]) ? "WHERE status = ?" : "";
      const values = where ? [status] : [];
      const [leads, totals] = await Promise.all([
        d1.prepare(`SELECT id, name, email, company, phone, headcount, interest, message, status, source_path, handled_at, created_at
          FROM fdp_marketing_leads ${where} ORDER BY created_at DESC LIMIT 100`).bind(...values).all<Record<string, unknown>>(),
        d1.prepare("SELECT status, count(*)::int AS total FROM fdp_marketing_leads GROUP BY status").all<{ status: string; total: number }>(),
      ]);
      return Response.json({
        leads: leads.results,
        totals: Object.fromEntries(totals.results.map((row) => [String(row.status), Number(row.total)])),
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
      const updated = await d1.prepare(`UPDATE fdp_marketing_leads SET status = ?, handled_by = ?, handled_at = now()
        WHERE id = ? RETURNING id, status`).bind(status, platform.userId, id).first<{ id: string; status: string }>();
      if (!updated) throw ApiError.notFound("Contato não encontrado.", "LEAD_NOT_FOUND");

      await d1.prepare(`INSERT INTO fdp_platform_audit_events (id, actor_user_id, actor_email, action, entity_type, entity_id, after_json)
        VALUES (?, ?, ?, 'marketing_lead.updated', 'marketing_lead', ?, ?::jsonb)`)
        .bind(crypto.randomUUID(), platform.userId, auth.user.email, id, JSON.stringify({ status }))
        .run();

      return Response.json({ lead: updated });
    });
  } catch (error) {
    return apiError(error);
  }
}
