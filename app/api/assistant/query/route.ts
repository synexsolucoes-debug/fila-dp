import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { hasCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import {
  buildNamedQuery, findNamedQuery, namedQueries, toNamedQueryResult,
  type NamedQueryResult,
} from "@/lib/assistant/named-queries";
import { log } from "@/lib/observability";
import { cleanText } from "@/lib/registrations";

/**
 * Consultas operacionais nomeadas (§61, §62, §63).
 *
 * Esta rota é a única forma de o assistente saber algo sobre a operação, e ela
 * não recebe SQL de ninguém: recebe a **chave** de uma consulta do catálogo. O
 * servidor valida quem pergunta, valida a capacidade, aplica o workspace,
 * aplica o escopo de empresa, executa a consulta escrita por nós, agrega e só
 * então entrega números.
 *
 * O registro (§63) guarda a consulta utilizada, o usuário, o workspace, o
 * horário, a duração e o resultado agregado. Não guarda a pergunta em texto
 * livre: ela é escrita pelo usuário e pode conter PII que não precisa ser
 * arquivada para responder "quem consultou o quê".
 */

export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { workspace } = await getWorkspaceContext(auth.user);
    return Response.json({
      queries: namedQueries.map((query) => ({
        key: query.key,
        question: query.question,
        description: query.description,
        // Consulta que a pessoa não pode fazer aparece nomeada com o motivo, em
        // vez de sumir da lista e parecer que o produto não sabe responder.
        available: hasCapability(workspace, query.capability),
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    const requestId = request.headers.get("x-fila-dp-request-id");

    const keys = Array.isArray(body.keys)
      ? body.keys.map((item) => cleanText(item, 60)).filter(Boolean).slice(0, 5)
      : [cleanText(body.key, 60)].filter(Boolean);
    if (!keys.length) {
      throw ApiError.badRequest("Informe qual consulta operacional executar.", "ASSISTANT_QUERY_REQUIRED");
    }

    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    const companyIds = access.unrestricted ? null : [...access.companyIds];

    const results: NamedQueryResult[] = [];
    const denied: Array<{ key: string; reason: string }> = [];
    for (const key of keys) {
      const query = findNamedQuery(key);
      if (!query) { denied.push({ key, reason: "unknown_query" }); continue; }
      if (!hasCapability(workspace, query.capability)) { denied.push({ key, reason: "missing_capability" }); continue; }

      const { sql, parameters } = buildNamedQuery({
        query, workspaceId: workspace.id, userId: user.id, companyIds,
      });
      const started = Date.now();
      let row: Record<string, unknown> | null = null;
      let failure = "";
      try {
        row = await d1.prepare(sql).bind(...parameters).first<Record<string, unknown>>();
      } catch (error) {
        failure = error instanceof Error ? error.name : "QueryError";
      }
      const durationMs = Date.now() - started;
      const result = toNamedQueryResult(query, row);
      if (!failure) results.push(result);

      /* Registro da consulta (§63). O log estrutural já recusa PII por
         construção; aqui entra só a chave, a duração e os agregados. */
      log(failure ? "error" : "info", "assistant.named_query", {
        workspaceId: workspace.id, userId: user.id, requestId,
      }, {
        query: query.key,
        durationMs,
        ...(failure ? { errorType: failure } : { values: result.values, omitted: result.omitted }),
      });
    }

    if (results.length) {
      await prepareAuditEvent({
        workspaceId: workspace.id,
        actorUserId: user.id,
        actorEmail: auth.user.email,
        action: "assistant.named_query",
        entityType: "assistant_query",
        entityId: results.map((result) => result.key).join(","),
        after: Object.fromEntries(results.map((result) => [result.key, result.values])),
        requestId,
      }).run();
    }

    return Response.json({ results, denied }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
