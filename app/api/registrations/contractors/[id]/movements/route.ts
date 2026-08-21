import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { centsFromDatabase } from "@/lib/payments";
import { contractorBalance, requireContractorProfile } from "@/lib/payment-service";
import { assertContractValueNotBelowConsumed, assertMovementEffect, movementLabels } from "@/lib/contractor-registry";
import { readMovementInput } from "@/lib/contractor-input";

type Params = { params: Promise<{ id: string }> };

/**
 * Registra uma movimentação do contrato do prestador.
 *
 * Nasce como rascunho e só altera o contrato quando for aplicada. Essa
 * separação é o ponto do recurso: um reajuste passa a ter data de vigência,
 * autor e motivo, em vez de ser uma edição silenciosa do cadastro que ninguém
 * consegue explicar três competências depois.
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.manage");

    const profile = await requireContractorProfile(d1, workspace.id, id);
    /* Sem porta por empresa: o prestador é do grupo (migração 0053). Quem
       decide aqui é a capacidade. Onde há empresa em jogo — competência,
       apuração, nota — o acesso é conferido contra a empresa daquela
       operação, que é quem paga, e não contra o cadastro. */

    const input = readMovementInput(body);
    assertMovementEffect(input.movementType, input.effect);

    // O que a movimentação vai reduzir é conferido já na criação: descobrir só
    // na hora de aplicar deixaria um rascunho impossível esperando aprovação.
    if (input.effect.contractTotalCents !== undefined) {
      const balance = await contractorBalance(d1, workspace.id, profile);
      assertContractValueNotBelowConsumed(input.effect.contractTotalCents, balance.consumedCents);
    }

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (input.effect.baseAmountCents !== undefined) {
      before.baseAmountCents = centsFromDatabase(profile.base_amount, "Valor fixo");
      after.baseAmountCents = input.effect.baseAmountCents;
    }
    if (input.effect.contractEnd !== undefined) {
      before.contractEnd = profile.contract_end;
      after.contractEnd = input.effect.contractEnd;
    }
    if (input.effect.contractTotalCents !== undefined) {
      before.contractTotalCents = profile.contract_total_amount === null || profile.contract_total_amount === undefined
        ? null : centsFromDatabase(profile.contract_total_amount, "Valor do contrato");
      after.contractTotalCents = input.effect.contractTotalCents;
    }
    if (input.effect.invoiceLimitCents !== undefined) {
      before.invoiceLimitCents = profile.invoice_limit_override === null || profile.invoice_limit_override === undefined
        ? null : centsFromDatabase(profile.invoice_limit_override, "Limite da nota");
      after.invoiceLimitCents = input.effect.invoiceLimitCents;
    }
    if (input.effect.complementMethod !== undefined) {
      before.complementMethod = profile.complement_method;
      after.complementMethod = input.effect.complementMethod;
    }
    if (input.effect.status !== undefined) {
      before.status = profile.status;
      after.status = input.effect.status;
    }

    const movementId = crypto.randomUUID();
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_contractor_movements
          (id, workspace_id, company_id, provider_id, movement_type, effective_date, title, before_json, after_json,
           reason, status, requested_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, 'draft', ?)`)
        .bind(movementId, workspace.id, profile.company_id ?? null, id, input.movementType, input.effectiveDate,
          input.title, JSON.stringify(before), JSON.stringify(after), input.reason, user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "contractor_movement.created", entityType: "contractor", entityId: id,
        before: null,
        after: { movementId, movementType: input.movementType, effectiveDate: input.effectiveDate, change: after },
        metadata: { title: input.title, label: movementLabels[input.movementType] },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ movement: { id: movementId, status: "draft" } }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
