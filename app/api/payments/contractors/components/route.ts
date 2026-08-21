import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import {

  contractorCreditTypes,
  contractorDebitTypes,
  paymentEnum,
  positiveMoney,
  paymentOrigins,
  requiredPaymentEnum,
  type ContractorComponentType,
} from "@/lib/payments";
import { createContractorComponent, requireContractorProfile, requireOpenCycle } from "@/lib/payment-service";
import { readBatchEntries } from "@/lib/contractor-input";

const componentTypes = [...contractorCreditTypes, ...contractorDebitTypes] as const;

/** Créditos e descontos da competência do prestador PJ. */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.payments.read");
    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    const cycleId = cleanText(url.searchParams.get("competenceId"), 120);
    const providerId = cleanText(url.searchParams.get("contractorId"), 120);
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);

    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    if (!access.unrestricted && access.companyIds.size === 0) return Response.json({ components: [] });
    const where = ["c.workspace_id = ?"];
    const values: unknown[] = [workspace.id];
    if (!access.unrestricted) {
      const ids = [...access.companyIds];
      where.push(`c.company_id IN (${ids.map(() => "?").join(",")})`);
      values.push(...ids);
    }
    if (companyId) { where.push("c.company_id = ?"); values.push(companyId); }
    if (cycleId) { where.push("c.payroll_cycle_id = ?"); values.push(cycleId); }
    if (providerId) { where.push("c.provider_id = ?"); values.push(providerId); }

    const rows = await d1.prepare(`SELECT c.id, c.company_id, c.provider_id, c.payroll_cycle_id, c.closing_id, c.competence, c.direction,
        c.component_type, c.description, c.component_quantity, c.amount, c.origin, c.document_reference, c.note, c.status, c.created_at,
        a.legal_name AS contractor_name
      FROM fdp_contractor_components c
      JOIN fdp_auxiliary_providers a ON a.workspace_id = c.workspace_id AND a.id = c.provider_id
      WHERE ${where.join(" AND ")} ORDER BY c.direction, c.component_type, c.created_at`).bind(...values).all<Record<string, unknown>>();
    return Response.json({ components: rows.results, creditTypes: contractorCreditTypes, debitTypes: contractorDebitTypes });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.payments.manage");

    const cycleId = cleanText(body.competenceId ?? body.payrollCycleId, 120);

    /* Lançamento em lote: o mesmo tipo, para vários prestadores de uma vez.
     *
     * É a segunda forma de lançar que a operação usa — escolher a rubrica e
     * percorrer a lista de prestadores preenchendo valor, em vez de abrir um
     * formulário por pessoa. Numa competência com trinta PJ e um reajuste de
     * plano de saúde, a diferença é entre trinta formulários e um.
     *
     * O lote entra pelo mesmo caminho do lançamento único, não por uma rota
     * paralela: capacidade, acesso à empresa, competência aberta e as regras
     * do componente são as mesmas, e uma segunda rota seria a segunda cópia
     * dessas verificações — com a chance de uma delas ficar para trás. */
    const entries = readBatchEntries(body.entries);
    if (entries) {
      if (!cycleId) throw ApiError.badRequest("Selecione a competência.", "COMPONENT_REQUIRED_FIELDS");
      const componentType = requiredPaymentEnum(body.componentType, componentTypes, "Tipo do componente") as ContractorComponentType;
      const description = cleanText(body.description, 240);
      const created: string[] = [];
      for (const entry of entries) {
        const profile = await requireContractorProfile(d1, workspace.id, entry.providerId);
        await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, profile.company_id);
        const cycle = await requireOpenCycle(d1, workspace.id, profile.company_id, cycleId);
        const component = await createContractorComponent(d1, {
          workspaceId: workspace.id, profile, cycle, componentType,
          amount: positiveMoney(entry.amount, `Valor de ${entry.providerId}`),
          description, quantity: 1, origin: "manual",
          documentReference: cleanText(body.documentReference, 160),
          note: cleanText(body.note, 300), externalId: "", createdBy: user.id,
        });
        created.push(component.id);
      }
      await prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "contractor_component.created_batch", entityType: "contractor_component", entityId: cycleId,
        after: { componentType, count: created.length, providerIds: entries.map((entry) => entry.providerId) },
        metadata: { source: "contractor_payments", description },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }).run();
      return Response.json({ created: created.length }, { status: 201 });
    }

    const providerId = cleanText(body.contractorId ?? body.providerId, 120);
    if (!providerId || !cycleId) throw ApiError.badRequest("Prestador e competência são obrigatórios.", "COMPONENT_REQUIRED_FIELDS");

    const profile = await requireContractorProfile(d1, workspace.id, providerId);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, profile.company_id);
    const cycle = await requireOpenCycle(d1, workspace.id, profile.company_id, cycleId);

    const componentType = requiredPaymentEnum(body.componentType, componentTypes, "Tipo do componente") as ContractorComponentType;
    const amount = positiveMoney(body.amount, "Valor do componente");

    const component = await createContractorComponent(d1, {
      workspaceId: workspace.id,
      profile,
      cycle,
      componentType,
      amount,
      description: cleanText(body.description, 240),
      quantity: Math.max(Number(body.quantity) || 1, 0),
      origin: paymentEnum(body.origin, paymentOrigins, "manual"),
      documentReference: cleanText(body.documentReference, 160),
      note: cleanText(body.note, 300),
      externalId: cleanText(body.externalId, 160),
      createdBy: user.id,
    });

    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "contractor_component.created", entityType: "contractor_component", entityId: component.id,
      after: { providerId, competence: cycle.competence, direction: component.direction, componentType, amount },
      metadata: { duplicated: component.duplicated },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return Response.json({ component }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
