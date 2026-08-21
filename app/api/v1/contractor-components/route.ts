import { getD1 } from "@/db";
import { ApiError } from "@/lib/api-errors";
import {
  apiV1Error, apiV1Response, authenticateApiRequest, beginIdempotentRequest, completeIdempotentRequest, requireScope,
} from "@/lib/api-v1";
import { log } from "@/lib/observability";
import {
  contractorCreditTypes, contractorDebitTypes, positiveMoney, requiredPaymentEnum, type ContractorComponentType,
} from "@/lib/payments";
import { createContractorComponent, requireCycle, requireContractorProfile } from "@/lib/payment-service";
import { cleanText } from "@/lib/registrations";

export const dynamic = "force-dynamic";

const componentTypes = [...contractorCreditTypes, ...contractorDebitTypes] as const;

/**
 * POST /api/v1/contractor-components — lança crédito ou desconto de um PJ.
 *
 * É o caminho pelo qual um ERP envia comissões e descontos do mês. A regra de
 * negócio é exatamente a mesma da interface: mesma função de serviço, mesmas
 * validações de competência fechada e fechamento concluído.
 *
 * Duas camadas evitam lançamento duplicado:
 * `Idempotency-Key` devolve a resposta original, e `externalId` reconhece o
 * registro já criado pelo sistema de origem.
 */
export async function POST(request: Request) {
  let requestId: string | undefined;
  try {
    const d1 = getD1();
    const context = await authenticateApiRequest(d1, request);
    requestId = context.requestId;
    requireScope(context, "payments.write");

    const rawBody = await request.text();
    if (rawBody.length > 16_000) throw ApiError.badRequest("Corpo da requisição excede 16 KB.", "REQUEST_TOO_LARGE");
    const idempotency = await beginIdempotentRequest(d1, context, request, "/api/v1/contractor-components", rawBody);
    if (idempotency.kind === "replay") {
      return apiV1Response(context, JSON.parse(idempotency.body || "{}"), idempotency.status, { "X-Fila-DP-Idempotent-Replay": "true" });
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody || "{}") as Record<string, unknown>;
    } catch {
      throw ApiError.badRequest("Corpo JSON inválido.", "INVALID_JSON");
    }

    const providerId = cleanText(body.contractorId, 120);
    const competence = cleanText(body.competence, 7);
    if (!providerId || !/^\d{4}-(0[1-9]|1[0-2])$/u.test(competence)) {
      throw ApiError.badRequest("Informe contractorId e competence no formato AAAA-MM.", "COMPONENT_REQUIRED_FIELDS");
    }

    const profile = await requireContractorProfile(d1, context.workspaceId, providerId);
    /* O prestador é do grupo, então não há "empresa do prestador" para achar a
       competência. Quando o grupo tem uma competência aberta só naquele mês, ela
       é a resposta e o cliente antigo continua funcionando sem mudar nada.
       Com mais de uma, a rota exige `companyId`: escolher a primeira seria
       lançar dinheiro na empresa errada em silêncio. */
    const companyId = cleanText(body.companyId, 120);
    const cycleRows = await d1.prepare(`SELECT id, company_id FROM fdp_payroll_cycles
      WHERE workspace_id = ? AND competence = ?${companyId ? " AND company_id = ?" : ""}`)
      .bind(...[context.workspaceId, competence, ...(companyId ? [companyId] : [])])
      .all<{ id: string; company_id: string }>();
    if (!cycleRows.results.length) throw ApiError.badRequest("Competência não aberta.", "INVALID_COMPETENCE");
    if (cycleRows.results.length > 1) {
      throw ApiError.badRequest(
        "Mais de uma empresa tem esta competência aberta. Informe companyId.",
        "COMPANY_REQUIRED_FOR_COMPETENCE",
      );
    }
    const cycle = await requireCycle(d1, context.workspaceId, String(cycleRows.results[0].company_id), String(cycleRows.results[0].id));

    const componentType = requiredPaymentEnum(body.componentType, componentTypes, "Tipo do componente") as ContractorComponentType;
    const amount = positiveMoney(body.amount, "Valor do componente");

    const component = await createContractorComponent(d1, {
      workspaceId: context.workspaceId,
      profile,
      cycle,
      componentType,
      amount,
      description: cleanText(body.description, 240),
      quantity: Math.max(Number(body.quantity) || 1, 0),
      origin: "integration",
      documentReference: cleanText(body.documentReference, 160),
      externalId: cleanText(body.externalId, 160),
      createdBy: `api-key:${context.apiKeyId}`.slice(0, 120),
    });

    // A auditoria do workspace registra a origem programática do lançamento.
    await d1.prepare(`INSERT INTO fdp_audit_events
        (id, workspace_id, actor_type, actor_user_id, actor_email, action, outcome, entity_type, entity_id, after_json, metadata_json, request_id)
      VALUES (?, ?, 'integration', NULL, ?, 'contractor_component.created', 'success', 'contractor_component', ?, ?::jsonb, ?::jsonb, ?)`)
      .bind(crypto.randomUUID(), context.workspaceId, `api-key:${context.apiKeyId}`, component.id,
        JSON.stringify({ providerId, competence, componentType, amount, direction: component.direction }),
        JSON.stringify({ apiKeyId: context.apiKeyId, duplicated: component.duplicated, origin: "integration" }),
        context.requestId)
      .run();

    log("info", "api_v1.component_created", { requestId: context.requestId, workspaceId: context.workspaceId, apiKeyId: context.apiKeyId }, {
      componentType, direction: component.direction, duplicated: component.duplicated,
    });

    const payload = { data: component };
    const status = component.duplicated ? 200 : 201;
    await completeIdempotentRequest(d1, context, idempotency, request, "/api/v1/contractor-components", status, JSON.stringify(payload));
    return apiV1Response(context, payload, status);
  } catch (error) {
    return apiV1Error(error, requestId);
  }
}
