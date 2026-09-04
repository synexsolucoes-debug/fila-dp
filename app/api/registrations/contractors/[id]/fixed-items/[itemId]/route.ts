import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { hasCapability, requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { requireContractorProfile, requireCycle, upsertContractorClosing } from "@/lib/payment-service";
import { assertCompetence } from "@/lib/contractor-registry";
import { readFixedItemEdit } from "@/lib/contractor-input";
import { fromCents } from "@/lib/payments";
import { cleanText } from "@/lib/registrations";

type Params = { params: Promise<{ id: string; itemId: string }> };

/**
 * Corrigir ou encerrar um valor recorrente.
 *
 * **Encerrar** é datar o fim da vigência, não apagar a linha: as competências
 * já apuradas com esse valor precisam continuar explicáveis. Apagar faria o
 * histórico mentir sobre o que foi pago.
 *
 * **Corrigir** não existia, e a falta era um beco sem saída: o componente
 * materializado na competência recusa edição dizendo "altere o lançamento fixo
 * de origem", e a origem só aceitava nascer e morrer. Um plano de saúde que
 * reajustou de 480 para 512 exigia encerrar o item e cadastrar outro — o que
 * troca o histórico de uma linha por duas e ainda erra a vigência se alguém
 * datar errado.
 *
 * As duas coisas cabem no mesmo verbo porque são a mesma linha, e o corpo diz
 * qual delas se quer: `effectiveTo` encerra, os demais campos corrigem, e vir
 * junto faz as duas.
 */
export async function PATCH(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id, itemId } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    /* Duas permissões alcançam esta linha porque dois lugares do produto a
       operam: o cadastro do prestador e a aba de Ajustes do módulo de
       Pagamentos. Quem já pode *criar* o recorrente pela tela de Pagamentos
       (`contractors.payments.manage`) precisa poder corrigi-lo por lá também —
       exigir a permissão do cadastro para editar o que ele mesmo lançou seria
       uma recusa que a tela não explica e que ninguém entende. */
    if (!hasCapability(workspace, "contractors.manage")) {
      requireCapability(workspace, "contractors.payments.manage");
    }

    // Confere que o prestador existe antes de mexer no item dele.
    await requireContractorProfile(d1, workspace.id, id);
    /* Sem porta por empresa: o prestador é do grupo (migração 0054). Quem
       decide aqui é a capacidade. Onde há empresa em jogo — competência,
       apuração, nota — o acesso é conferido contra a empresa daquela
       operação, que é quem paga, e não contra o cadastro. */

    const item = await d1.prepare(`SELECT id, direction, component_type, description, amount, settlement_target,
        effective_from, effective_to, note, status
      FROM fdp_contractor_fixed_items WHERE workspace_id = ? AND provider_id = ? AND id = ?`)
      .bind(workspace.id, id, itemId)
      .first<{
        id: string; direction: string; component_type: string; description: string; amount: string | number;
        settlement_target: string; effective_from: string; effective_to: string | null; note: string; status: string;
      }>();
    if (!item) throw ApiError.notFound("Valor recorrente não encontrado.", "FIXED_ITEM_NOT_FOUND");

    const encerrarRaw = cleanText(body.effectiveTo, 7);
    const encerrar = encerrarRaw ? assertCompetence(encerrarRaw, "Competência final") : null;
    if (encerrar && encerrar < item.effective_from) {
      throw ApiError.badRequest(
        "A competência final não pode ser anterior à inicial. Para desfazer um lançamento errado, cancele o componente da competência.",
        "FIXED_ITEM_WINDOW_INVALID",
      );
    }

    const edicao = readFixedItemEdit(body);
    if (!encerrar && !edicao.temAlteracao) {
      throw ApiError.badRequest("Informe o que mudar no valor recorrente.", "FIXED_ITEM_NOTHING_TO_CHANGE");
    }

    /* Um UPDATE só, com `COALESCE` decidindo o que fica: montar a lista de
       campos em texto tiraria a consulta do alcance do `verify:sql`, que é
       quem prova contra o schema real que ela existe e casa com as colunas. */
    await d1.batch([
      d1.prepare(`UPDATE fdp_contractor_fixed_items SET
          amount = COALESCE(?::numeric, amount),
          description = COALESCE(?, description),
          component_type = COALESCE(?, component_type),
          direction = COALESCE(?, direction),
          settlement_target = COALESCE(?, settlement_target),
          note = COALESCE(?, note),
          effective_to = COALESCE(?, effective_to),
          status = CASE WHEN ?::text IS NULL THEN status ELSE 'ended' END,
          updated_at = now()
        WHERE workspace_id = ? AND provider_id = ? AND id = ?`)
        .bind(
          edicao.amountCents === null ? null : fromCents(edicao.amountCents),
          edicao.description, edicao.componentType, edicao.direction, edicao.settlementTarget, edicao.note,
          encerrar, encerrar, workspace.id, id, itemId,
        ),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: encerrar && !edicao.temAlteracao ? "contractor_fixed_item.ended" : "contractor_fixed_item.updated",
        entityType: "contractor", entityId: id,
        before: {
          itemId, amount: Number(item.amount), description: item.description, componentType: item.component_type,
          settlementTarget: item.settlement_target, effectiveTo: item.effective_to, status: item.status,
        },
        after: {
          itemId,
          amount: edicao.amountCents === null ? Number(item.amount) : fromCents(edicao.amountCents),
          description: edicao.description ?? item.description,
          componentType: edicao.componentType ?? item.component_type,
          settlementTarget: edicao.settlementTarget ?? item.settlement_target,
          effectiveTo: encerrar ?? item.effective_to,
          status: encerrar ? "ended" : item.status,
        },
        metadata: { effectiveFrom: item.effective_from },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    /* O valor recorrente vira componente em cada competência aberta, e o
       componente já materializado guarda o valor antigo. Sem reapurar aqui, a
       correção só apareceria na próxima vez que alguém apurasse — e até lá a
       tela mostraria um número que ninguém mais reconhece. Competência fechada
       ou paga permanece imutável, como no resto do módulo. */
    const profile = await requireContractorProfile(d1, workspace.id, id);
    const abertas = await d1.prepare(`SELECT payroll_cycle_id, company_id FROM fdp_contractor_closings
      WHERE workspace_id = ? AND provider_id = ? AND status NOT IN ('closed', 'paid') AND excluded_at IS NULL`)
      .bind(workspace.id, id)
      .all<{ payroll_cycle_id: string; company_id: string }>();
    const recalculated = [];
    for (const closing of abertas.results) {
      const cycle = await requireCycle(d1, workspace.id, closing.company_id, closing.payroll_cycle_id);
      const result = await upsertContractorClosing(d1, { workspaceId: workspace.id, profile, cycle, userId: user.id });
      recalculated.push({ id: result.closingId, competence: cycle.competence, netAmount: result.calculation.netAmount });
    }

    return Response.json({ ok: true, recalculated });
  } catch (error) {
    return apiError(error);
  }
}
