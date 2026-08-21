import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { apurationBlock, type ContractorStatus } from "@/lib/contractor-registry";
import { requireCycle, requireContractorProfile, upsertContractorClosing } from "@/lib/payment-service";

function operationalBlock(
  status: ContractorStatus,
  competence: string,
  contractStart: string | null,
  contractEnd: string | null,
) {
  return apurationBlock(status, competence, contractStart, contractEnd);
}

/**
 * Apura o fechamento PJ da competência aplicando a ordem obrigatória:
 * base + créditos - descontos = líquido devido; nota = mínimo(líquido, limite);
 * complemento = líquido - nota; Caju = complemento quando configurado.
 *
 * A reapuração também saneia fechamentos que ficaram para trás depois de uma
 * demissão/encerramento: eles são excluídos logicamente, nunca apagados.
 */
export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.payments.manage");

    const companyId = cleanText(body.companyId, 120);
    const cycleId = cleanText(body.competenceId ?? body.payrollCycleId, 120);
    const providerId = cleanText(body.contractorId ?? body.providerId, 120);
    if (!companyId || !cycleId) throw ApiError.badRequest("Empresa e competência são obrigatórias.", "CONTRACTOR_CLOSING_REQUIRED_FIELDS");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const cycle = await requireCycle(d1, workspace.id, companyId, cycleId);

    const removed: Record<string, unknown>[] = [];
    const existingRows = await d1.prepare(`SELECT c.id AS closing_id, c.provider_id, c.status AS closing_status, c.net_amount,
        p.status AS contractor_status, p.contract_start, p.contract_end, a.legal_name
      FROM fdp_contractor_closings c
      JOIN fdp_contractor_profiles p ON p.workspace_id = c.workspace_id AND p.provider_id = c.provider_id
      JOIN fdp_auxiliary_providers a ON a.workspace_id = c.workspace_id AND a.id = c.provider_id
      WHERE c.workspace_id = ? AND c.company_id = ? AND c.payroll_cycle_id = ? AND c.excluded_at IS NULL`)
      .bind(workspace.id, companyId, cycleId)
      .all<{
        closing_id: string; provider_id: string; closing_status: string; net_amount: string | number;
        contractor_status: string; contract_start: string | null; contract_end: string | null; legal_name: string;
      }>();

    for (const row of existingRows.results) {
      if (providerId && row.provider_id !== providerId) continue;
      const blocked = operationalBlock(
        row.contractor_status as ContractorStatus,
        cycle.competence,
        row.contract_start,
        row.contract_end,
      );
      if (!blocked) continue;
      if (row.closing_status === "paid" || row.closing_status === "closed") {
        requireCapability(workspace, "payments.reopen");
      }

      const reason = `Removido automaticamente pela reapuração: ${blocked}.`;
      await d1.batch([
        d1.prepare(`UPDATE fdp_contractor_closings
          SET excluded_at = now(), excluded_by = ?, exclusion_reason = ?, updated_at = now()
          WHERE workspace_id = ? AND id = ? AND excluded_at IS NULL`)
          .bind(user.id, reason, workspace.id, row.closing_id),
        prepareAuditEvent({
          workspaceId: workspace.id,
          actorUserId: user.id,
          actorEmail: auth.user.email,
          action: "contractor_closing.excluded_by_recalculation",
          entityType: "contractor_closing",
          entityId: row.closing_id,
          before: { providerId: row.provider_id, status: row.closing_status, netAmount: Number(row.net_amount) },
          after: { excluded: true, blockedReason: blocked },
          metadata: { competence: cycle.competence, automatic: true },
          requestId: request.headers.get("x-fila-dp-request-id"),
        }),
      ]);
      removed.push({
        id: row.closing_id,
        providerId: row.provider_id,
        contractorName: row.legal_name,
        competence: cycle.competence,
        removed: true,
        blockedReason: blocked,
      });
    }

    // Se foi a reapuração individual de um PJ que acabou de ser demitido, o
    // trabalho terminou acima: a linha antiga já saiu do módulo.
    if (providerId && removed.some((item) => item.providerId === providerId)) {
      return Response.json({ closings: removed, removedCount: removed.length });
    }

    // Exclusão manual da competência é respeitada: "Apurar competência" não
    // ressuscita silenciosamente um pagamento que o operador excluiu.
    const excludedRows = await d1.prepare(`SELECT provider_id FROM fdp_contractor_closings
      WHERE workspace_id = ? AND company_id = ? AND payroll_cycle_id = ? AND excluded_at IS NOT NULL`)
      .bind(workspace.id, companyId, cycleId)
      .all<{ provider_id: string }>();
    const excludedProviders = new Set(excludedRows.results.map((row) => String(row.provider_id)));

    /* Sem prestador informado, carrega os PJ operacionais do grupo — não os de
       uma empresa. O prestador é do grupo: é ele quem presta serviço para as
       empresas, e a empresa que apura é quem paga naquela competência.
       Um pagamento excluído não volta a nascer silenciosamente na reapuração. */
    const providerIds = (providerId
      ? [providerId]
      : (await d1.prepare(`SELECT provider_id FROM fdp_contractor_profiles
          WHERE workspace_id = ? AND status IN ('active', 'inactive')
            AND (contract_start IS NULL OR contract_start <= ?) AND (contract_end IS NULL OR contract_end >= ?)`)
        .bind(workspace.id, `${cycle.competence}-01`, `${cycle.competence}-01`)
        .all<{ provider_id: string }>()).results.map((row) => String(row.provider_id)))
      .filter((id) => !excludedProviders.has(id));

    /* Quem já foi apurado nesta competência por outra empresa do grupo fica de
       fora: o prestador recebe uma vez por mês, e é a primeira apuração que
       define quem paga. Sem isto, apurar agosto na Empresa A e depois na
       Empresa B geraria dois pagamentos para a mesma pessoa — e o segundo
       pareceria tão correto quanto o primeiro. O banco também recusa, pelo
       índice único; aqui a recusa vira uma linha explicada na tela em vez de
       um erro de gravação. */
    const jaApurados = new Map((await d1.prepare(`SELECT c.provider_id, coalesce(e.trade_name, e.legal_name) AS empresa
      FROM fdp_contractor_closings c
      JOIN fdp_companies e ON e.workspace_id = c.workspace_id AND e.id = c.company_id
      WHERE c.workspace_id = ? AND c.competence = ? AND c.company_id <> ? AND c.excluded_at IS NULL`)
      .bind(workspace.id, cycle.competence, companyId)
      .all<{ provider_id: string; empresa: string }>()).results.map((row) => [String(row.provider_id), String(row.empresa)]));

    if (!providerIds.length) {
      return Response.json({ closings: removed, removedCount: removed.length });
    }

    const closings: Record<string, unknown>[] = [...removed];
    for (const id of providerIds) {
      const profile = await requireContractorProfile(d1, workspace.id, id);
      const outraEmpresa = jaApurados.get(id);
      if (outraEmpresa) {
        closings.push({
          providerId: id,
          contractorName: profile.legal_name,
          competence: cycle.competence,
          removed: false,
          blockedReason: `já apurado nesta competência por ${outraEmpresa}`,
        });
        continue;
      }

      const blocked = operationalBlock(
        profile.status as ContractorStatus,
        cycle.competence,
        profile.contract_start,
        profile.contract_end,
      );
      if (blocked) {
        closings.push({
          providerId: id,
          contractorName: profile.legal_name,
          competence: cycle.competence,
          removed: false,
          blockedReason: blocked,
        });
        continue;
      }

      const result = await upsertContractorClosing(d1, { workspaceId: workspace.id, profile, cycle, userId: user.id });
      await prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: result.created ? "contractor_closing.created" : "contractor_closing.recalculated",
        entityType: "contractor_closing", entityId: result.closingId,
        after: {
          providerId: id, competence: cycle.competence, contractBaseAmount: result.calculation.contractBaseAmount,
          baseAmount: result.calculation.baseAmount, prorationDays: result.calculation.prorationDays,
          prorationTotalDays: result.calculation.prorationTotalDays, prorationEndDate: result.calculation.prorationEndDate,
          netAmount: result.calculation.netAmount,
          invoiceExpectedAmount: result.calculation.invoiceExpectedAmount, complementAmount: result.calculation.complementAmount,
          cajuAmount: result.calculation.cajuAmount, invoiceLimitSource: result.calculation.invoiceLimitSource,
        },
        metadata: { calcVersion: result.calculation.calcVersion, componentCount: result.componentCount, limitPolicyId: result.limitPolicyId },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }).run();
      closings.push({
        id: result.closingId, providerId: id, contractorName: profile.legal_name, competence: cycle.competence,
        ...result.calculation,
        blockedReason: result.calculation.requiresComplementMethod ? "COMPLEMENT_METHOD_REQUIRED" : null,
      });
    }
    return Response.json({ closings, removedCount: removed.length });
  } catch (error) {
    return apiError(error);
  }
}
