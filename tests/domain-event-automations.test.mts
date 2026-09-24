import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { matchesDomainEventRule } from "../lib/domain-event-conditions.ts";
import type { DomainEventName } from "../lib/domain-events.ts";

/**
 * Motor de Jornadas — passo 1 (`lib/domain-event-automations.ts`).
 *
 * `runDomainEventAutomations` toca `fdp_automation_rules`, `fdp_process_versions`,
 * `fdp_boards`/`fdp_lists`, `fdp_cards` e `fdp_domain_events` na mesma chamada —
 * exatamente como `prepareProcessInstance`, que o resto da suíte já verifica
 * por leitura de código (`tests/demand-from-process.test.mts`), não por um
 * banco de mentira que simularia SQL. Os testes abaixo seguem a mesma
 * convenção para a parte que toca banco (e por isso nunca importam
 * `lib/domain-event-automations.ts` em tempo de execução: ele carrega
 * `lib/fila-dp-db.ts`, que importa `../db` por valor — algo que só o bundler da
 * aplicação resolve). `matchesDomainEventRule` é testada diretamente, porque
 * mora num módulo puro à parte (`lib/domain-event-conditions.ts`) exatamente
 * para poder ser importada aqui.
 */

const admitted = (payload: Record<string, unknown> = {}, entityId = "emp-1") => ({
  name: "employee.admitted" as DomainEventName,
  entityId,
  payload,
  idempotencyKey: "idem-1",
});

/* ── `matchesDomainEventRule` (pura) ─────────────────────────────────────── */

test("uma condição sem `domainEvent` não combina com nada", () => {
  assert.equal(matchesDomainEventRule({}, admitted()), false);
  assert.equal(matchesDomainEventRule({ companyId: "empresa-1" }, admitted({ companyId: "empresa-1" })), false);
});

test("o nome do evento precisa bater exatamente", () => {
  assert.equal(matchesDomainEventRule({ domainEvent: "termination.requested" }, admitted()), false);
  assert.equal(matchesDomainEventRule({ domainEvent: "employee.admitted" }, admitted()), true);
});

test("as demais chaves da condição comparam contra o payload", () => {
  const event = admitted({ companyId: "empresa-1" });
  assert.equal(matchesDomainEventRule({ domainEvent: "employee.admitted", companyId: "empresa-1" }, event), true);
  assert.equal(matchesDomainEventRule({ domainEvent: "employee.admitted", companyId: "empresa-2" }, event), false);
});

test("`entityId` na condição compara contra a entidade do evento, não contra o payload", () => {
  const event = admitted({}, "emp-42");
  assert.equal(matchesDomainEventRule({ domainEvent: "employee.admitted", entityId: "emp-42" }, event), true);
  assert.equal(matchesDomainEventRule({ domainEvent: "employee.admitted", entityId: "emp-99" }, event), false);
});

test("uma chave com valor `undefined` na condição não restringe nada", () => {
  // A tela pode gravar `{ domainEvent: "...", companyId: undefined }` para uma
  // condição que ainda não foi preenchida; isso não pode se comportar como
  // "companyId precisa ser undefined", o que nunca combinaria com nada.
  assert.equal(
    matchesDomainEventRule({ domainEvent: "employee.admitted", companyId: undefined }, admitted({ companyId: "x" })),
    true,
  );
});

/* ── `runDomainEventAutomations` (toca banco) ────────────────────────────── */

test("a automação nunca lança por causa de uma regra: cada falha vira `skipped` e as demais continuam", async () => {
  const source = await readFile(new URL("../lib/domain-event-automations.ts", import.meta.url), "utf8");
  const executor = source.slice(source.indexOf("export async function runDomainEventAutomations"));
  assert.match(executor, /catch \(error\) \{/u);
  assert.match(executor, /outcome: "skipped"/u);
  assert.doesNotMatch(executor.slice(executor.indexOf("} catch (error) {", executor.lastIndexOf("await d1.batch("))), /throw error/u,
    "uma regra que falhou não pode derrubar a resposta de quem só queria registrar o fato");
});

test("a chave de idempotência amarra a regra ao evento — a mesma regra duas vezes não abre duas demandas", async () => {
  const source = await readFile(new URL("../lib/domain-event-automations.ts", import.meta.url), "utf8");
  assert.match(source, /deriveIdempotencyKey\(\{/u);
  assert.match(source, /externalId: `automation:\$\{ruleId\}:\$\{event\.idempotencyKey\}`/u);
  assert.match(source, /findEventByIdempotencyKey\(d1, workspaceId, idempotencyKey\)/u,
    "a checagem prévia evita gastar uma tentativa de instanciar antes de saber que já existe");
});

test("a instância nasce pela mesma função da instanciação manual, com as mesmas garantias", async () => {
  const source = await readFile(new URL("../lib/domain-event-automations.ts", import.meta.url), "utf8");
  assert.match(source, /await loadPublishedVersion\(d1, workspaceId, processVersionId\)/u,
    "só uma versão publicada pode virar demanda — a mesma regra da rota manual");
  assert.match(source, /await prepareProcessInstance\(d1, \{/u);
  assert.match(source, /onConflict: "raise"/u,
    "o evento process.instance_started precisa abortar a transação se a chave já existir");
});

test("sem quadro com coluna de entrada, a regra é ignorada com motivo — não quebra nem inventa quadro", async () => {
  const source = await readFile(new URL("../lib/domain-event-automations.ts", import.meta.url), "utf8");
  assert.match(source, /kind = 'new'/u);
  assert.match(source, /outcome: "skipped", ruleId, ruleName, reason: "nenhum quadro com coluna de entrada disponível"/u);
});

test("regra sem `instantiateProcessVersionId` na ação não tenta instanciar nada", async () => {
  const source = await readFile(new URL("../lib/domain-event-automations.ts", import.meta.url), "utf8");
  assert.match(source, /if \(!processVersionId\) \{/u);
});

/* ── O primeiro emissor: criação manual de colaborador ───────────────────── */

test("criar colaborador emite `employee.admitted` no mesmo lote do cadastro", async () => {
  const route = await readFile(new URL("../app/api/employees/route.ts", import.meta.url), "utf8");
  assert.match(route, /name: "employee\.admitted"/u);
  assert.match(route, /entityId: row\.id/u);
  const batchStart = route.indexOf("await d1.batch([");
  const batchEnd = route.indexOf("]);", batchStart);
  const batch = route.slice(batchStart, batchEnd);
  assert.match(batch, /prepareDomainEventFromEnvelope\(d1, admissionEvent,/u,
    "o evento precisa nascer na mesma transação do colaborador, não depois");
});

test("a automação roda depois do lote, nunca antes — e nunca derruba a resposta", async () => {
  const route = await readFile(new URL("../app/api/employees/route.ts", import.meta.url), "utf8");
  const batchIndex = route.indexOf("await d1.batch([");
  const automationIndex = route.indexOf("await runDomainEventAutomations(");
  assert.ok(batchIndex > -1 && automationIndex > batchIndex,
    "o colaborador precisa estar gravado antes de qualquer automação reagir a ele");
  const afterAutomationCall = route.slice(automationIndex, route.indexOf("const created =", automationIndex));
  assert.match(afterAutomationCall, /\.catch\(/u,
    "uma automação mal configurada não pode derrubar a resposta de um cadastro que já foi confirmado");
});
