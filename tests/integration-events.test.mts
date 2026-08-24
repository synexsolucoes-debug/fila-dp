import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  completeIntegrationEvent, listIntegrationEvents, processIntegrationEvent,
  recordIntegrationEvent, reopenIntegrationEvent,
} from "../lib/integration-events.ts";
import { ApiError } from "../lib/api-errors.ts";

/**
 * A central de eventos existe para uma garantia só: o mesmo evento externo não
 * gera trabalho interno duas vezes. Estes testes exercitam essa garantia contra
 * um banco falso que se comporta como o PostgreSQL se comporta — em especial,
 * respeitando o índice único (workspace, integração, evento externo), que é onde
 * a idempotência realmente mora.
 */

type Row = Record<string, unknown>;

/** Banco em memória com a constraint de unicidade que o schema declara. */
function fakeDatabase() {
  const rows: Row[] = [];
  const queries: string[] = [];

  const runQuery = (query: string, args: unknown[]): Row[] => {
    queries.push(query);
    const sql = query.replace(/\s+/gu, " ").trim();

    if (sql.startsWith("INSERT INTO fdp_integration_events")) {
      const [id, workspaceId, integrationId, connector, eventType, externalEventId, source] = args as string[];
      const clash = rows.find((row) => row.workspace_id === workspaceId
        && row.integration_id === integrationId
        && row.external_event_id === externalEventId);
      // ON CONFLICT DO NOTHING: a segunda inserção não devolve linha.
      if (clash) return [];
      const row: Row = {
        id, workspace_id: workspaceId, integration_id: integrationId, connector, event_type: eventType,
        external_event_id: externalEventId, source, status: "received", result_type: "", result_id: "",
        error_code: "", error_message: "", retry_count: 0,
        received_at: new Date().toISOString(), processed_at: null,
      };
      rows.push(row);
      return [{ ...row }];
    }

    if (sql.startsWith("SELECT") && sql.includes("FROM fdp_integration_events") && sql.includes("external_event_id = ?")) {
      const [workspaceId, integrationId, externalEventId] = args as string[];
      const found = rows.find((row) => row.workspace_id === workspaceId
        && row.integration_id === integrationId
        && row.external_event_id === externalEventId);
      return found ? [{ ...found }] : [];
    }

    if (sql.startsWith("UPDATE fdp_integration_events SET status = 'processing'")) {
      const [workspaceId, eventId] = args as string[];
      const found = rows.find((row) => row.workspace_id === workspaceId && row.id === eventId
        && ["received", "error", "reprocessed"].includes(String(row.status)));
      if (!found) return [];
      found.status = "processing";
      return [{ id: found.id, status: found.status }];
    }

    if (sql.startsWith("UPDATE fdp_integration_events SET status = 'reprocessed'")) {
      const [workspaceId, eventId] = args as string[];
      const found = rows.find((row) => row.workspace_id === workspaceId && row.id === eventId
        && ["error", "ignored"].includes(String(row.status)));
      if (!found) return [];
      found.status = "reprocessed";
      found.error_code = "";
      found.error_message = "";
      return [{ id: found.id }];
    }

    if (sql.startsWith("UPDATE fdp_integration_events SET status = ?")) {
      const [status, resultType, resultId, errorCode, errorMessage, retryDelta, workspaceId, eventId] = args as never[];
      const found = rows.find((row) => row.workspace_id === workspaceId && row.id === eventId);
      if (found) {
        Object.assign(found, {
          status, result_type: resultType, result_id: resultId, error_code: errorCode,
          error_message: errorMessage, retry_count: Number(found.retry_count) + Number(retryDelta),
          processed_at: new Date().toISOString(),
        });
      }
      return [];
    }

    if (sql.includes("FROM fdp_integration_events") && sql.includes("ORDER BY received_at DESC")) {
      const [workspaceId, ...rest] = args as string[];
      let selected = rows.filter((row) => row.workspace_id === workspaceId);
      if (sql.includes("integration_id = ?")) selected = selected.filter((row) => row.integration_id === rest.shift());
      if (sql.includes("status = ?")) selected = selected.filter((row) => row.status === rest.shift());
      return selected.map((row) => ({ ...row }));
    }

    return [];
  };

  return {
    rows,
    queries,
    prepare(query: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() { return (runQuery(query, args)[0] ?? null) as T | null; },
            async all<T>() { return { results: runQuery(query, args) as T[] }; },
            async run() { return runQuery(query, args); },
          };
        },
      };
    },
  };
}

const base = { workspaceId: "ws-a", integrationId: "int-a", connector: "teams", eventType: "channel_message" };

test("o mesmo evento externo só é registrado uma vez", async () => {
  const d1 = fakeDatabase();
  const first = await recordIntegrationEvent(d1, { ...base, externalEventId: "teams:msg-1" });
  const second = await recordIntegrationEvent(d1, { ...base, externalEventId: "teams:msg-1" });

  assert.equal(first.kind, "new");
  assert.equal(second.kind, "duplicate");
  // O identificador devolvido é o do evento original: quem trata a reentrega
  // consegue responder apontando para o efeito que já existe.
  assert.equal(second.event.id, first.event.id);
  assert.equal(d1.rows.length, 1, "reentrega não pode criar um segundo evento");
});

test("o mesmo identificador em workspaces diferentes são eventos diferentes", async () => {
  // Dois clientes podem receber mensagens com o mesmo id do provedor. Se a
  // chave não incluísse o workspace, o evento de um sumiria por causa do outro.
  const d1 = fakeDatabase();
  const a = await recordIntegrationEvent(d1, { ...base, externalEventId: "teams:msg-1" });
  const b = await recordIntegrationEvent(d1, { ...base, workspaceId: "ws-b", externalEventId: "teams:msg-1" });
  assert.equal(a.kind, "new");
  assert.equal(b.kind, "new");
  assert.equal(d1.rows.length, 2);
});

test("evento sem identificador de origem é recusado", async () => {
  // Sem identificador estável não existe idempotência possível; aceitar em
  // silêncio criaria demanda nova a cada reentrega.
  const d1 = fakeDatabase();
  await assert.rejects(
    () => recordIntegrationEvent(d1, { ...base, externalEventId: "  " }),
    (error: unknown) => error instanceof ApiError && error.code === "INTEGRATION_EVENT_ID_REQUIRED",
  );
});

test("o ciclo de processamento fecha o evento com o resultado", async () => {
  const d1 = fakeDatabase();
  const recorded = await recordIntegrationEvent(d1, { ...base, externalEventId: "teams:msg-2" });
  assert.equal(recorded.kind, "new");

  const result = await processIntegrationEvent(d1, "ws-a", recorded.event, async () => ({
    outcome: { status: "processed" as const, resultType: "card", resultId: "card-1" },
    value: "card-1",
  }));

  assert.equal(result.handled, true);
  assert.equal(result.value, "card-1");
  assert.equal(d1.rows[0].status, "processed");
  assert.equal(d1.rows[0].result_id, "card-1");
});

test("um evento já processado não é processado de novo", async () => {
  const d1 = fakeDatabase();
  const recorded = await recordIntegrationEvent(d1, { ...base, externalEventId: "teams:msg-3" });
  await processIntegrationEvent(d1, "ws-a", recorded.event, async () => ({
    outcome: { status: "processed" as const, resultType: "card", resultId: "card-1" },
    value: "card-1",
  }));

  let ranAgain = false;
  const second = await processIntegrationEvent(d1, "ws-a", recorded.event, async () => {
    ranAgain = true;
    return { outcome: { status: "processed" as const, resultType: "card", resultId: "card-2" }, value: "card-2" };
  });

  assert.equal(second.handled, false, "a reclamação do evento precisa falhar quando ele já terminou");
  assert.equal(ranAgain, false, "o trabalho não pode rodar de novo");
  assert.equal(d1.rows[0].result_id, "card-1", "o resultado original é preservado");
});

test("falha no processamento fecha o evento como erro, e não o deixa preso", async () => {
  // Um evento preso em `processing` bloquearia toda retentativa futura.
  const d1 = fakeDatabase();
  const recorded = await recordIntegrationEvent(d1, { ...base, externalEventId: "teams:msg-4" });

  await assert.rejects(() => processIntegrationEvent(d1, "ws-a", recorded.event, async () => {
    throw new ApiError(502, "PROVIDER_DOWN", "O provedor não respondeu.");
  }));

  assert.equal(d1.rows[0].status, "error");
  assert.equal(d1.rows[0].error_code, "PROVIDER_DOWN");
  assert.equal(d1.rows[0].retry_count, 1);
});

test("evento com erro pode ser reaberto; evento processado não", async () => {
  const d1 = fakeDatabase();
  const recorded = await recordIntegrationEvent(d1, { ...base, externalEventId: "teams:msg-5" });
  await completeIntegrationEvent(d1, "ws-a", recorded.event.id, {
    status: "error", code: "PROVIDER_DOWN", message: "timeout",
  });
  await reopenIntegrationEvent(d1, "ws-a", recorded.event.id);
  assert.equal(d1.rows[0].status, "reprocessed");
  assert.equal(d1.rows[0].error_code, "", "reabrir limpa o erro anterior");

  await completeIntegrationEvent(d1, "ws-a", recorded.event.id, {
    status: "processed", resultType: "card", resultId: "card-9",
  });
  await assert.rejects(
    () => reopenIntegrationEvent(d1, "ws-a", recorded.event.id),
    (error: unknown) => error instanceof ApiError && error.code === "INTEGRATION_EVENT_NOT_RETRYABLE",
  );
});

test("a listagem de eventos é sempre filtrada pelo workspace", async () => {
  const d1 = fakeDatabase();
  await recordIntegrationEvent(d1, { ...base, externalEventId: "a-1" });
  await recordIntegrationEvent(d1, { ...base, workspaceId: "ws-b", externalEventId: "b-1" });

  const listed = await listIntegrationEvents(d1, "ws-a");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].workspace_id, "ws-a");
  // O workspace entra como parâmetro vinculado, e não interpolado na string:
  // é o que impede injeção pelo filtro e o que mantém a cláusula obrigatória.
  assert.ok(d1.queries.some((query) => query.includes("workspace_id = ?")));
});

test("o limite da listagem é preso a uma faixa segura", async () => {
  const d1 = fakeDatabase();
  await recordIntegrationEvent(d1, { ...base, externalEventId: "a-1" });
  await listIntegrationEvents(d1, "ws-a", { limit: 999_999 });
  const listQuery = d1.queries.find((query) => query.includes("ORDER BY received_at DESC")) ?? "";
  assert.match(listQuery, /LIMIT 200/u, "um limite vindo do cliente não pode virar varredura completa");
});

test("a migration declara a chave de idempotência e o isolamento por workspace", async () => {
  const migration = await readFile(
    new URL("../drizzle/postgres/0037_integration_events_and_workspace_lifecycle.sql", import.meta.url),
    "utf8",
  );
  // A garantia é do banco: sem este índice, duas entregas simultâneas do mesmo
  // webhook passam pela verificação em código ao mesmo tempo e as duas criam.
  assert.match(migration, /CREATE UNIQUE INDEX[^;]+fdp_integration_events_idempotency_uq[^;]+"workspace_id", "integration_id", "external_event_id"/u);
  assert.match(migration, /ALTER TABLE "fdp_integration_events" ENABLE ROW LEVEL SECURITY/u);
  assert.match(migration, /ALTER TABLE "fdp_integration_events" FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /fdp_integration_events_workspace_isolation/u);
  assert.match(migration, /ALTER TABLE "fdp_movement_suggestions" FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /fdp_movement_suggestions_workspace_isolation/u);
  // A chave composta impede um evento apontar para integração de outro grupo.
  assert.match(migration, /fdp_integration_events_workspace_integration_fk[\s\S]{0,200}fdp_integrations"\("workspace_id", "id"\)/u);
});
