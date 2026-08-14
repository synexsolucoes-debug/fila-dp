import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { readFixedItemInput } from "@/lib/contractor-input";
import { fromCents } from "@/lib/payments";
import { requireContractorProfile } from "@/lib/payment-service";
import { cleanText } from "@/lib/registrations";

/**
 * Cria um crédito ou desconto recorrente a partir do módulo Pagamentos PJ.
 *
 * A vigência pertence ao lançamento, não à competência atualmente aberta. Um
 * término informado torna a recorrência determinada; em branco, ela segue sem
 * prazo. A materialização continua idempotente no fechamento de cada mês.
 */
export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.payments.manage");

    const providerId = cleanText(body.providerId ?? body.contractorId, 120);
    if (!providerId) throw ApiError.badRequest("Selecione o prestador.", "CONTRACTOR_REQUIRED");

    const profile = await requireContractorProfile(d1, workspace.id, providerId);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, profile.company_id);

    const input = readFixedItemInput(body);
    const itemId = crypto.randomUUID();

    await d1.batch([
      d1.prepare(`INSERT INTO fdp_contractor_fixed_items
          (id, workspace_id, company_id, provider_id, direction, component_type, description, amount,
           effective_from, effective_to, note, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(itemId, workspace.id, profile.company_id, providerId, input.direction, input.componentType,
          input.description, fromCents(input.amountCents), input.effectiveFrom, input.effectiveTo,
          input.note, user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "contractor_fixed_item.created", entityType: "contractor", entityId: providerId,
        before: null,
        after: {
          itemId, direction: input.direction, componentType: input.componentType,
          amountCents: input.amountCents, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo,
        },
        metadata: { source: "contractor_payments", description: input.description },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ fixedItem: { id: itemId, providerId } }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
