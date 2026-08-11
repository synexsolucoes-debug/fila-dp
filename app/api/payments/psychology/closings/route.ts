import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { requireCycle, requireProvider, upsertPsychologyClosing } from "@/lib/payment-service";

/**
 * Apura o fechamento do psicólogo na competência: quantas consultas válidas
 * ele realizou e quanto devemos pagar. A apuração é idempotente e pode ser
 * repetida enquanto o fechamento não estiver pago ou concluído.
 */
export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "psychology.payments.manage");

    const companyId = cleanText(body.companyId, 120);
    const cycleId = cleanText(body.competenceId ?? body.payrollCycleId, 120);
    const providerId = cleanText(body.psychologistId ?? body.providerId, 120);
    if (!companyId || !cycleId) throw ApiError.badRequest("Empresa e competência são obrigatórias.", "PSYCHOLOGY_CLOSING_REQUIRED_FIELDS");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const cycle = await requireCycle(d1, workspace.id, companyId, cycleId);

    // Sem psicólogo informado, reapura todos os que possuem lançamentos na competência.
    const providerIds = providerId
      ? [providerId]
      : (await d1.prepare(`SELECT DISTINCT provider_id FROM fdp_psychology_sessions
          WHERE workspace_id = ? AND company_id = ? AND payroll_cycle_id = ?`)
        .bind(workspace.id, companyId, cycleId).all<{ provider_id: string }>()).results.map((row) => String(row.provider_id));
    if (!providerIds.length) throw ApiError.badRequest("Não há consultas lançadas nesta competência.", "PSYCHOLOGY_NO_SESSIONS");

    const closings = [];
    for (const id of providerIds) {
      await requireProvider(d1, workspace.id, id, "psychologist");
      const result = await upsertPsychologyClosing(d1, { workspaceId: workspace.id, companyId, providerId: id, cycle, userId: user.id });
      await prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: result.created ? "psychology_closing.created" : "psychology_closing.recalculated",
        entityType: "psychology_closing", entityId: result.closingId,
        after: { providerId: id, competence: cycle.competence, ...result.totals },
        metadata: { calcVersion: result.totals.calcVersion },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }).run();
      closings.push({ id: result.closingId, providerId: id, competence: cycle.competence, ...result.totals });
    }
    return Response.json({ closings });
  } catch (error) {
    return apiError(error);
  }
}
