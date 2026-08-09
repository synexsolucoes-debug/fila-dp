import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import {
  componentDirectionFor,
  contractorCreditTypes,
  contractorDebitTypes,
  paymentEnum,
  positiveMoney,
  paymentOrigins,
  requiredPaymentEnum,
  type ContractorComponentType,
} from "@/lib/payments";
import { requireContractorProfile, requireOpenCycle } from "@/lib/payment-service";

const componentTypes = [...contractorCreditTypes, ...contractorDebitTypes] as const;

/** Créditos e descontos da competência do prestador PJ. */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "contractors.payments.read");
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
    requireCapability(workspace.role, "contractors.payments.manage");

    const providerId = cleanText(body.contractorId ?? body.providerId, 120);
    const cycleId = cleanText(body.competenceId ?? body.payrollCycleId, 120);
    if (!providerId || !cycleId) throw ApiError.badRequest("Prestador e competência são obrigatórios.", "COMPONENT_REQUIRED_FIELDS");

    const profile = await requireContractorProfile(d1, workspace.id, providerId);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, profile.company_id);
    const cycle = await requireOpenCycle(d1, workspace.id, profile.company_id, cycleId);

    const componentType = requiredPaymentEnum(body.componentType, componentTypes, "Tipo do componente") as ContractorComponentType;
    const direction = componentDirectionFor(componentType);
    const amount = positiveMoney(body.amount, "Valor do componente");
    if (amount <= 0) throw ApiError.badRequest("Informe um valor maior que zero.", "COMPONENT_AMOUNT_REQUIRED");

    const closing = await d1.prepare("SELECT id, status FROM fdp_contractor_closings WHERE workspace_id = ? AND provider_id = ? AND payroll_cycle_id = ?")
      .bind(workspace.id, providerId, cycleId).first<{ id: string; status: string }>();
    if (closing && (closing.status === "closed" || closing.status === "paid")) {
      throw ApiError.badRequest("O fechamento desta competência está concluído. Reabra com justificativa para lançar componentes.", "PAYMENT_CLOSING_LOCKED");
    }

    const id = crypto.randomUUID();
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_contractor_components (id, workspace_id, company_id, provider_id, payroll_cycle_id, closing_id, competence,
          direction, component_type, description, component_quantity, amount, origin, document_reference, note, status, external_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
        .bind(id, workspace.id, profile.company_id, providerId, cycleId, closing?.id ?? null, cycle.competence, direction, componentType,
          cleanText(body.description, 240), Math.max(Number(body.quantity) || 1, 0), amount,
          paymentEnum(body.origin, paymentOrigins, "manual"), cleanText(body.documentReference, 160), cleanText(body.note, 300),
          cleanText(body.externalId, 160), user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "contractor_component.created", entityType: "contractor_component", entityId: id,
        after: { providerId, competence: cycle.competence, direction, componentType, amount },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ component: { id, direction, componentType, amount, competence: cycle.competence } }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
