import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";
import { addDays, isIsoDay } from "@/lib/dp-calendar";
import { areaReport } from "@/lib/dp-cutoff";
import { todayInBrazil } from "@/lib/employee-history";

function period(url: URL) {
  const today = todayInBrazil();
  const from = url.searchParams.get("de") ?? "";
  const to = url.searchParams.get("ate") ?? "";
  return { from: isIsoDay(from) ? from : `${today.slice(0, 7)}-01`, to: isIsoDay(to) ? to : today };
}

/**
 * Ocorrências do período e o relatório por área: total de demandas com regra
 * de corte, em aberto, fora do corte e % fora do corte.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "portfolio.read", "consultar as ocorrências do DP");
    const { from, to } = period(new URL(request.url));
    const end = addDays(to, 1);
    const [occurrences, cards] = await Promise.all([
      d1.prepare(`SELECT o.id, o.occurred_on::text AS occurred_on, o.area, o.fact, o.impact, o.origin, o.days_late, o.card_id,
          COALESCE(NULLIF(co.trade_name, ''), co.legal_name, '') AS company_name, u.name AS registered_by_name
        FROM fdp_dp_occurrences o
        LEFT JOIN fdp_companies co ON co.workspace_id = o.workspace_id AND co.id = o.company_id
        LEFT JOIN fdp_users u ON u.id = o.registered_by
        WHERE o.workspace_id = ? AND o.occurred_on >= ?::date AND o.occurred_on < ?::date
        ORDER BY o.occurred_on DESC, o.created_at DESC LIMIT 500`)
        .bind(workspace.id, from, end).all<Record<string, unknown>>(),
      d1.prepare(`SELECT c.requester_area_label AS area, c.within_cutoff, c.process_type,
          (c.archived = 0 AND c.closed_at IS NULL AND c.sla_status <> 'completed') AS open
        FROM fdp_cards c
        WHERE c.workspace_id = ? AND c.cutoff_rule_code <> '' AND c.created_at >= ?::date AND c.created_at < ?::date`)
        .bind(workspace.id, from, end).all<Record<string, unknown>>(),
    ]);
    const rows = cards.results.map((row) => ({ area: String(row.area ?? ""), open: row.open === true, within: row.within_cutoff === null ? null : row.within_cutoff === true }));
    const byType = areaReport(cards.results.map((row) => ({ area: String(row.process_type ?? ""), open: row.open === true, within: row.within_cutoff === null ? null : row.within_cutoff === true })));
    return Response.json({
      from, to,
      byArea: areaReport(rows),
      byType,
      occurrences: occurrences.results.map((row) => ({
        id: String(row.id), occurredOn: String(row.occurred_on).slice(0, 10), area: String(row.area ?? ""),
        companyName: String(row.company_name ?? ""), fact: String(row.fact), impact: String(row.impact ?? ""),
        origin: String(row.origin), daysLate: row.days_late === null ? null : Number(row.days_late),
        cardId: row.card_id ? String(row.card_id) : null, registeredBy: String(row.registered_by_name ?? (row.origin === "automatica" ? "Automática" : "")),
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}

/** Ocorrência registrada à mão (origem manual). */
export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "portfolio.manage", "registrar ocorrências do DP");
    const occurredOn = cleanText(body.occurredOn, 10) || todayInBrazil();
    const fact = cleanText(body.fact, 1000);
    if (!isIsoDay(occurredOn)) throw ApiError.badRequest("Data inválida.", "DP_OCCURRENCE_DATE");
    if (!fact) throw ApiError.badRequest("Descreva o fato.", "DP_OCCURRENCE_FACT");
    const companyId = cleanText(body.companyId, 120) || null;
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const id = crypto.randomUUID();
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_dp_occurrences (id, workspace_id, occurred_on, area, company_id, card_id, fact, impact, origin, registered_by)
        VALUES (?, ?, ?::date, ?, ?, NULL, ?, ?, 'manual', ?)`)
        .bind(id, workspace.id, occurredOn, cleanText(body.area, 120), companyId, fact, cleanText(body.impact, 1000), user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "dp_occurrence.created", entityType: "dp_occurrence", entityId: id,
        after: { occurredOn, area: cleanText(body.area, 120), companyId }, requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ id }, { status: 201 });
  } catch (error) { return apiError(error); }
}
