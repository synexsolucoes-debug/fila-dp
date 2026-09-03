import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { fromCents } from "@/lib/payments";
import { requireContractorProfile } from "@/lib/payment-service";
import { readFixedItemInput } from "@/lib/contractor-input";

type Params = { params: Promise<{ id: string }> };

/**
 * Valores que se repetem todo mês para o prestador.
 *
 * O item é lançado uma vez com a vigência; as competências seguintes o recebem
 * sozinhas. Relançar todo mês na mão erra por esquecimento — e o esquecimento
 * só aparece quando o prestador reclama do valor a menos.
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
    /* Sem porta por empresa: o prestador é do grupo (migração 0054). Quem
       decide aqui é a capacidade. Onde há empresa em jogo — competência,
       apuração, nota — o acesso é conferido contra a empresa daquela
       operação, que é quem paga, e não contra o cadastro. */

    const input = readFixedItemInput(body);
    const itemId = crypto.randomUUID();

    await d1.batch([
      d1.prepare(`INSERT INTO fdp_contractor_fixed_items
          (id, workspace_id, company_id, provider_id, direction, component_type, description, amount,
           settlement_target, effective_from, effective_to, note, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(itemId, workspace.id, profile.company_id ?? null, id, input.direction, input.componentType,
          input.description, fromCents(input.amountCents), input.settlementTarget, input.effectiveFrom, input.effectiveTo,
          input.note, user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "contractor_fixed_item.created", entityType: "contractor", entityId: id,
        before: null,
        after: {
          itemId, direction: input.direction, componentType: input.componentType,
          amountCents: input.amountCents, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo,
        },
        metadata: { description: input.description },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ fixedItem: { id: itemId } }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
