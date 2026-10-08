import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { readBatchEntries, readFixedItemInput } from "@/lib/contractor-input";
import { fromCents } from "@/lib/payments";
import { recalculateOpenContractorClosings, requireContractorProfile } from "@/lib/payment-service";
import { cleanText } from "@/lib/registrations";

/**
 * Cria um crédito ou desconto recorrente a partir do módulo Pagamentos PJ.
 *
 * A vigência pertence ao lançamento, não à competência atualmente aberta. Um
 * término informado torna a recorrência determinada; em branco, ela segue sem
 * prazo. A materialização continua idempotente no fechamento de cada mês, e as
 * competências do prestador já apuradas e ainda abertas são reapuradas na hora
 * — senão o mês seguinte, apurado antes do cadastro, ficava sem o lançamento.
 */
export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.payments.manage");

    /* Lote, pelo mesmo caminho do lançamento único — ver o comentário na rota
       de componentes. Aqui vale para as duas naturezas que moram nesta tabela:
       fixo é o item sem competência final, determinado é o com. */
    const entries = readBatchEntries(body.entries);
    if (entries) {
      const created: string[] = [];
      const statements = [];
      for (const entry of entries) {
        const profile = await requireContractorProfile(d1, workspace.id, entry.providerId);
        /* Sem porta por empresa: o prestador é do grupo (migração 0054). Quem
       decide aqui é a capacidade. Onde há empresa em jogo — competência,
       apuração, nota — o acesso é conferido contra a empresa daquela
       operação, que é quem paga, e não contra o cadastro. */
        const input = readFixedItemInput({ ...body, amount: entry.amount });
        const itemId = crypto.randomUUID();
        created.push(itemId);
        statements.push(d1.prepare(`INSERT INTO fdp_contractor_fixed_items
            (id, workspace_id, company_id, provider_id, direction, component_type, description, amount,
             settlement_target, effective_from, effective_to, note, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(itemId, workspace.id, profile.company_id ?? null, entry.providerId, input.direction, input.componentType,
            input.description, fromCents(input.amountCents), input.settlementTarget, input.effectiveFrom, input.effectiveTo,
            input.note, user.id));
      }
      const amostra = readFixedItemInput({ ...body, amount: entries[0].amount });
      statements.push(prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "contractor_fixed_item.created_batch", entityType: "contractor", entityId: amostra.componentType,
        before: null,
        after: {
          componentType: amostra.componentType, direction: amostra.direction,
          effectiveFrom: amostra.effectiveFrom, effectiveTo: amostra.effectiveTo,
          count: created.length, providerIds: entries.map((entry) => entry.providerId),
        },
        metadata: { source: "contractor_payments", description: amostra.description },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }));
      await d1.batch(statements);
      const recalculated = [];
      const failed = [];
      for (const providerId of new Set(entries.map((entry) => entry.providerId))) {
        const result = await recalculateOpenContractorClosings(d1, { workspaceId: workspace.id, providerId, userId: user.id });
        recalculated.push(...result.recalculated);
        failed.push(...result.failed.map((item) => ({ ...item, providerId })));
      }
      return Response.json({ created: created.length, recalculated, failed }, { status: 201 });
    }

    const providerId = cleanText(body.providerId ?? body.contractorId, 120);
    if (!providerId) throw ApiError.badRequest("Selecione o prestador.", "CONTRACTOR_REQUIRED");

    const profile = await requireContractorProfile(d1, workspace.id, providerId);
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
        .bind(itemId, workspace.id, profile.company_id ?? null, providerId, input.direction, input.componentType,
          input.description, fromCents(input.amountCents), input.settlementTarget, input.effectiveFrom, input.effectiveTo,
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

    const { recalculated, failed } = await recalculateOpenContractorClosings(d1, { workspaceId: workspace.id, providerId, userId: user.id });
    return Response.json({ fixedItem: { id: itemId, providerId }, recalculated, failed }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
