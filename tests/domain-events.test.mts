import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildDomainEvent, deriveIdempotencyKey, domainEventCatalog, domainEventNames,
  findDomainEvent, isSensitiveDomainEvent, requireDomainEvent,
} from "../lib/domain-events.ts";
import { externalEventId, occurrenceKey, reprocessKey } from "../lib/idempotency.ts";
import { domainEventTypes, isDomainEventType, sanitizeEventPayload } from "../lib/outbox.ts";

/* O catálogo é o vocabulário do produto (§6). Os testes abaixo cobrem as três
   coisas que, se quebrarem, quebram tudo o que depende dele: o catálogo ser
   único, o envelope ser validado, e a chave de idempotência identificar a
   ocorrência em vez da execução. */

test("o catálogo declara os eventos operacionais exigidos pela arquitetura", () => {
  const required = [
    "employee.admitted", "employee.changed", "admission.created", "admission.status_changed",
    "admission.approved", "salary.change_requested", "approval.completed", "approval.rejected",
    "pj.invoice_requested", "pj.invoice_received", "time.inconsistency_detected",
    "epi.delivery_requested", "integration.failed", "integration.recovered",
  ];
  for (const name of required) {
    assert.ok(findDomainEvent(name), `evento ausente do catálogo: ${name}`);
  }
});

test("cada evento declara versão, entidade, origem e risco", () => {
  for (const item of domainEventCatalog) {
    assert.ok(item.schemaVersion >= 1, `${item.name} sem versão de esquema`);
    assert.ok(item.entityType.length > 0, `${item.name} sem entityType`);
    assert.ok(item.origins.length > 0, `${item.name} sem origem declarada`);
    assert.ok(["routine", "sensitive"].includes(item.risk), `${item.name} sem risco declarado`);
    assert.ok(item.description.length > 10, `${item.name} sem descrição útil`);
  }
});

test("o outbox deriva os tipos assináveis do catálogo, sem segunda lista", async () => {
  const source = await readFile(new URL("../lib/outbox.ts", import.meta.url), "utf8");
  // Uma lista literal de nomes de evento aqui seria a divergência voltando.
  assert.ok(!/"psychology_closing\.closed"/u.test(source),
    "o outbox voltou a manter a própria lista de eventos");
  assert.equal(domainEventTypes.length, domainEventNames.length);
  assert.ok(isDomainEventType("competence.closed"));
  assert.ok(!isDomainEventType("competence.inventada"));
});

test("os eventos que clientes já assinam continuam existindo", () => {
  // Remover um destes quebraria endpoints instalados (§76).
  const legacy = [
    "psychology_closing.closed", "contractor_closing.closed", "competence.closed",
    "time_sheet.approved", "sankhya.employee.updated", "tangerino.admission.status_changed",
  ];
  for (const name of legacy) assert.ok(findDomainEvent(name), `evento legado removido: ${name}`);
});

test("ações que mexem em dinheiro ou vínculo são marcadas como sensíveis", () => {
  assert.ok(isSensitiveDomainEvent("salary.change_requested"));
  assert.ok(isSensitiveDomainEvent("approval.completed"));
  assert.ok(isSensitiveDomainEvent("contractor_closing.closed"));
  assert.ok(!isSensitiveDomainEvent("integration.failed"));
});

test("evento fora do catálogo é recusado no ponto de emissão", () => {
  assert.throws(() => requireDomainEvent("admission.inventada"), /DOMAIN_EVENT_UNKNOWN|fora do catálogo/u);
});

test("origem que o evento não aceita é recusada", () => {
  assert.throws(
    () => buildDomainEvent({ name: "pj.invoice_requested", origin: "teams", workspaceId: "w1" }),
    /não é publicado pela origem/u,
  );
});

test("o envelope carrega tudo que a arquitetura exige", () => {
  const envelope = buildDomainEvent({
    name: "admission.status_changed",
    origin: "tangerino",
    workspaceId: "w1",
    entityId: "emp-1",
    externalId: "adm-99",
    occurredAt: "2026-08-20T10:00:00.000Z",
    payload: { normalizedStatus: "waiting_documents" },
    evidenceRefs: ["consultation:abc"],
  });
  assert.equal(envelope.name, "admission.status_changed");
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.origin, "tangerino");
  assert.equal(envelope.entityType, "admission");
  assert.equal(envelope.entityId, "emp-1");
  assert.equal(envelope.externalId, "adm-99");
  assert.equal(envelope.occurredAt, "2026-08-20T10:00:00.000Z");
  assert.ok(envelope.receivedAt >= envelope.occurredAt);
  assert.equal(envelope.idempotencyKey.length, 64);
  // Sem correlação informada, ela nasce da própria chave: nunca vazia.
  assert.equal(envelope.correlationId, envelope.idempotencyKey);
  assert.deepEqual(envelope.evidenceRefs, ["consultation:abc"]);
});

test("a mesma ocorrência entregue duas vezes produz a mesma chave", () => {
  const input = {
    name: "admission.status_changed" as const,
    origin: "tangerino" as const,
    workspaceId: "w1",
    externalId: "adm-99",
    occurredAt: "2026-08-20T10:00:00.000Z",
  };
  const first = buildDomainEvent(input);
  const second = buildDomainEvent({ ...input, receivedAt: "2026-08-20T11:30:00.000Z" });
  assert.equal(first.idempotencyKey, second.idempotencyKey,
    "o instante de recebimento não pode entrar na chave");
});

test("ocorrências diferentes não colidem", () => {
  const base = { workspaceId: "w1", name: "admission.status_changed", origin: "tangerino" };
  const one = deriveIdempotencyKey({ ...base, externalId: "adm-1" });
  const other = deriveIdempotencyKey({ ...base, externalId: "adm-2" });
  const otherWorkspace = deriveIdempotencyKey({ ...base, workspaceId: "w2", externalId: "adm-1" });
  assert.notEqual(one, other);
  assert.notEqual(one, otherWorkspace);
});

test("o payload é filtrado pelas chaves que o evento declara", () => {
  const safe = sanitizeEventPayload(
    { normalizedStatus: "approved", netAmount: 999, companyId: "c1" },
    "admission.status_changed",
  );
  assert.deepEqual(safe, { normalizedStatus: "approved", companyId: "c1" },
    "um evento de admissão não pode carregar valor financeiro por acidente");
});

test("evento anterior ao catálogo continua sob a allowlist geral", () => {
  const safe = sanitizeEventPayload({ netAmount: 100, competence: "2026-08" }, "contractor_closing.closed");
  assert.deepEqual(safe, { netAmount: 100, competence: "2026-08" });
});

test("a chave de ocorrência é vazia quando não há como identificar a ocorrência", () => {
  assert.equal(occurrenceKey({ workspaceId: "w1", source: "teams", kind: "message" }), "");
  assert.ok(occurrenceKey({ workspaceId: "w1", source: "teams", kind: "message", externalId: "m1" }));
  assert.ok(occurrenceKey({ workspaceId: "w1", source: "teams", kind: "message", payload: "{}" }));
});

test("o identificador externo separa canais para não descartar mensagem alheia", () => {
  assert.equal(externalEventId("teams", "m1"), "teams:m1");
  assert.notEqual(externalEventId("teams", "m1"), externalEventId("email", "m1"));
  assert.equal(externalEventId("teams", ""), "");
  assert.ok(externalEventId("teams", "", "{}").startsWith("teams:hash:"));
});

test("reprocessar deliberadamente produz chave nova; a mesma tentativa, não", () => {
  const base = occurrenceKey({ workspaceId: "w1", source: "teams", kind: "message", externalId: "m1" });
  assert.equal(reprocessKey(base, 0), base);
  assert.notEqual(reprocessKey(base, 1), base);
  assert.equal(reprocessKey(base, 1), reprocessKey(base, 1));
});
