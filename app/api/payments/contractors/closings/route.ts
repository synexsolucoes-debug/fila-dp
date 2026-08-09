import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { requireCycle, requireContractorProfile, upsertContractorClosing } from "@/lib/payment-service";

/**
 * Apura o fechamento PJ da competência aplicando a ordem obrigatória:
 * base + créditos - descontos = líquido devido; nota = mínimo(líquido, limite);
 * complemento = líquido - nota; Caju = complemento quando configurado.
 */
export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "contractors.payments.manage");

    const companyId = cleanText(body.companyId, 120);
    const cycleId = cleanText(body.competenceId ?? body.payrollCycleId, 120);
    const providerId = cleanText(body.contractorId ?? body.providerId, 120);
    if (!companyId || !cycleId) throw ApiError.badRequest("Empresa e competência são obrigatórias.", "CONTRACTOR_CLOSING_REQUIRED_FIELDS");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const cycle = await requireCycle(d1, workspace.id, companyId, cycleId);

    // Sem prestador informado, carrega todos os PJ ativos da empresa (fluxo mensal §47).
    const providerIds = providerId
      ? [providerId]
      : (await d1.prepare(`SELECT provider_id FROM fdp_contractor_profiles
          WHERE workspace_id = ? AND company_id = ? AND status = 'active'
            AND (contract_start IS NULL OR contract_start <= ?) AND (contract_end IS NULL OR contract_end >= ?)`)
        .bind(workspace.id, companyId, `${cycle.competence}-01`, `${cycle.competence}-01`).all<{ provider_id: string }>()).results.map((row) => String(row.provider_id));
    if (!providerIds.length) throw ApiError.badRequest("Não há prestadores PJ ativos nesta competência.", "CONTRACTOR_NO_ACTIVE_PROFILES");

    const closings = [];
    for (const id of providerIds) {
      const profile = await requireContractorProfile(d1, workspace.id, id);
      if (profile.company_id !== companyId) continue;
      const result = await upsertContractorClosing(d1, { workspaceId: workspace.id, profile, cycle, userId: user.id });
      await prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: result.created ? "contractor_closing.created" : "contractor_closing.recalculated",
        entityType: "contractor_closing", entityId: result.closingId,
        after: {
          providerId: id, competence: cycle.competence, netAmount: result.calculation.netAmount,
          invoiceExpectedAmount: result.calculation.invoiceExpectedAmount, complementAmount: result.calculation.complementAmount,
          cajuAmount: result.calculation.cajuAmount, invoiceLimitSource: result.calculation.invoiceLimitSource,
        },
        metadata: { calcVersion: result.calculation.calcVersion, componentCount: result.componentCount, limitPolicyId: result.limitPolicyId },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }).run();
      closings.push({
        id: result.closingId, providerId: id, contractorName: profile.legal_name, competence: cycle.competence,
        ...result.calculation,
        // Complemento configurado é obrigatório para concluir: a interface mostra o bloqueio.
        blockedReason: result.calculation.requiresComplementMethod ? "COMPLEMENT_METHOD_REQUIRED" : null,
      });
    }
    return Response.json({ closings });
  } catch (error) {
    return apiError(error);
  }
}
