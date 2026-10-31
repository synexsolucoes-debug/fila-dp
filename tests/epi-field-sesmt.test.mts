import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildEpiCompliance } from "../lib/epi-compliance.ts";
import { disposalTouchesStock } from "../lib/epi.ts";
import {
  awaitingDisposals, countByStatus, daysBetween, disposalStockEffect, dueDateLabel, dueDeliveryReason, dueEntries,
  matchesTerm, pendingSanitization,
} from "../app/campo/sesmt.logic.ts";

/**
 * Telas do SESMT no Vinculato Campo (app de iPhone, instalado pelo Safari).
 *
 * O que estes testes prendem:
 *
 *  1. a lista de vencimentos sai na ordem de gravidade do mapa de
 *     conformidade — quem está sem EPI antes de quem tem troca chegando;
 *  2. a entrega aberta a partir de uma pendência leva o motivo certo para o
 *     termo (troca não vira "primeira entrega");
 *  3. higienização mostra só o que ainda pede tratamento, e descarte diz a
 *     verdade sobre o estoque — a mesma regra do servidor;
 *  4. decisão sobre registro existente (higienização, descarte) nunca entra na
 *     fila sem rede; movimentação de estoque entra, com idempotência.
 */

const today = "2026-10-31";
const employee = (id: string, name: string) => ({
  id, companyId: "c1", name, registrationNumber: `M-${id}`, departmentId: "d1", departmentName: "Operação",
  positionId: "p1", positionName: "Operador",
});
const requirement = (productId: string, productName: string, extra: Partial<Parameters<typeof buildEpiCompliance>[1][number]> = {}) => ({
  id: `r-${productId}`, companyId: "c1", departmentId: "", departmentName: "", positionId: "", positionName: "",
  productId, productName, caNumber: "12345", caExpiresOn: "", productExpiresOn: "",
  quantity: 1, replacementDays: 90, warningDays: 15, ...extra,
});

test("vencimentos saem na ordem de gravidade e, dentro dela, do mais antigo", () => {
  const compliance = buildEpiCompliance(
    [employee("e1", "Bruno"), employee("e2", "Ana"), employee("e3", "Carla"), employee("e4", "Davi")],
    [requirement("capacete", "Capacete"), requirement("luva", "Luva", { caExpiresOn: "2026-10-01" })],
    [
      // Bruno: capacete com troca atrasada, luva com CA vencido.
      { employeeId: "e1", productId: "capacete", quantity: 1, lastDeliveredOn: "2026-06-01" },
      { employeeId: "e1", productId: "luva", quantity: 1, lastDeliveredOn: "2026-10-20" },
      // Ana: sem capacete; luva vencida.
      { employeeId: "e2", productId: "luva", quantity: 1, lastDeliveredOn: "2026-10-20" },
      // Carla: capacete com troca em 10 dias.
      { employeeId: "e3", productId: "capacete", quantity: 1, lastDeliveredOn: "2026-08-12" },
      { employeeId: "e3", productId: "luva", quantity: 1, lastDeliveredOn: "2026-10-20" },
    ],
    today,
  );
  const entries = dueEntries(compliance);
  const statuses = entries.map((entry) => entry.status);
  const firstOf = (status: string) => statuses.indexOf(status as never);
  assert.ok(firstOf("missing") < firstOf("expired"), "sem EPI vem antes de vencido");
  assert.ok(firstOf("expired") < firstOf("overdue"), "vencido vem antes de troca atrasada");
  assert.ok(firstOf("overdue") < firstOf("due_soon"), "troca atrasada vem antes de troca próxima");
  assert.ok(entries.every((entry) => entry.status !== ("compliant" as never)), "em dia não entra na lista");

  const counts = countByStatus(entries);
  assert.equal(counts.missing, 3, "Ana sem capacete, Davi sem capacete e sem luva");
  assert.equal(counts.due_soon, 1);
  assert.equal(entries.find((entry) => entry.status === "expired")?.date, "2026-10-01", "vencido carrega a data do CA");
});

test("a entrega aberta da pendência leva o motivo certo para o termo", () => {
  assert.equal(dueDeliveryReason.missing, "first_delivery");
  assert.equal(dueDeliveryReason.expired, "expiry_replacement");
  assert.equal(dueDeliveryReason.overdue, "periodic_exchange");
  assert.equal(dueDeliveryReason.due_soon, "periodic_exchange");
});

test("a data da pendência é dita em relação a hoje", () => {
  assert.equal(daysBetween("2026-10-31", "2026-11-03"), 3);
  assert.equal(dueDateLabel({ status: "expired", date: "2026-10-19", expiryReason: "CA", missingQuantity: 0 }, today), "CA venceu há 12 dias");
  assert.equal(dueDateLabel({ status: "expired", date: "2026-10-30", expiryReason: "produto", missingQuantity: 0 }, today), "Validade venceu há 1 dia");
  assert.equal(dueDateLabel({ status: "overdue", date: "2026-10-28", expiryReason: "", missingQuantity: 0 }, today), "Troca atrasada há 3 dias");
  assert.equal(dueDateLabel({ status: "due_soon", date: "2026-10-31", expiryReason: "", missingQuantity: 0 }, today), "Troca vence hoje");
  assert.equal(dueDateLabel({ status: "due_soon", date: "2026-11-10", expiryReason: "", missingQuantity: 0 }, today), "Troca em 10 dias");
  assert.equal(dueDateLabel({ status: "missing", date: "", expiryReason: "", missingQuantity: 2 }, today), "Faltam 2 unidades");
});

test("o filtro encontra sem acento e sem caixa", () => {
  const [entry] = dueEntries(buildEpiCompliance([employee("e1", "João Conceição")], [requirement("p", "Protetor auricular")], [], today));
  assert.ok(matchesTerm(entry, "joao"));
  assert.ok(matchesTerm(entry, "CONCEICAO"));
  assert.ok(matchesTerm(entry, "auricular"));
  assert.ok(matchesTerm(entry, "M-e1"));
  assert.ok(!matchesTerm(entry, "capacete"));
});

test("higienização mostra só o que ainda pede tratamento, em andamento primeiro", () => {
  const items = pendingSanitization([
    { id: "a", epi_name: "Luva", employee_full_name: "Ana", quantity: 2, returned_on: "2026-10-10", sanitization_status: "awaiting" },
    { id: "b", epi_name: "Máscara", employee_full_name: "Bia", employee_social_name: "Bia S.", quantity: 1, returned_on: "2026-10-20", sanitization_status: "in_progress" },
    { id: "c", epi_name: "Capacete", quantity: 1, returned_on: "2026-10-01", sanitization_status: "sanitized" },
    { id: "d", epi_name: "Óculos", quantity: 1, returned_on: "2026-10-01", sanitization_status: "rejected" },
  ]);
  assert.deepEqual(items.map((item) => item.id), ["b", "a"]);
  assert.equal(items[0].employeeName, "Bia S.", "nome social tem precedência");
});

test("descarte lista o que aguarda e diz a verdade sobre o estoque", () => {
  const items = awaitingDisposals([
    { id: "x", status: "awaiting_disposal", origin_type: "return", quantity: 1, disposal_date: "2026-10-20", disposal_reason: "unusable_return" },
    { id: "y", status: "disposed", origin_type: "manual", quantity: 1, disposal_date: "2026-10-01" },
    { id: "z", status: "awaiting_disposal", origin_type: "manual", quantity: 3, disposal_date: "2026-10-05", disposal_reason: "expired" },
  ]);
  assert.deepEqual(items.map((item) => item.id), ["z", "x"]);
  for (const origin of ["manual", "return", "damage"] as const) {
    assert.equal(disposalStockEffect(origin, 1).startsWith("Dá baixa"), disposalTouchesStock(origin),
      `a frase da tela para origem ${origin} precisa bater com a regra do servidor`);
  }
});

test("decisão sobre registro existente não entra na fila; estoque entra com idempotência", async () => {
  const api = await readFile(new URL("../app/campo/field.api.ts", import.meta.url), "utf8");
  const kinds = api.match(/export type QueuedKind = ([^;]+);/u)?.[1] ?? "";
  assert.match(kinds, /"stock_entry"/u);
  assert.match(kinds, /"stock_transfer"/u);
  assert.doesNotMatch(kinds, /sanitiz|dispos/u, "higienização e descarte não podem esperar na fila");

  for (const route of ["stock/entries", "stock/transfers"]) {
    const source = await readFile(new URL(`../app/api/epi/${route}/route.ts`, import.meta.url), "utf8");
    assert.match(source, /idempotency-key/u, `${route} precisa deduplicar para ser enfileirável`);
  }

  const flows = await readFile(new URL("../app/campo/SesmtFlows.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(flows, /submitOperation\(\{\s*kind: "(sanitization|disposal)/u);
  assert.match(flows, /window\.confirm\(`Confirmar o descarte/u, "descarte é definitivo e pede confirmação");
});

test("o app de campo se instala no iPhone e abre direto nos vencimentos", async () => {
  const manifest = await readFile(new URL("../app/manifest.ts", import.meta.url), "utf8");
  assert.match(manifest, /display: "standalone"/u);
  assert.match(manifest, /acao=vencimentos/u);
  const page = await readFile(new URL("../app/campo/page.tsx", import.meta.url), "utf8");
  assert.match(page, /appleWebApp: \{ capable: true/u);
  const app = await readFile(new URL("../app/campo/FieldApp.tsx", import.meta.url), "utf8");
  assert.match(app, /vencimentos: \{ screen: "due"/u);
  assert.match(app, /Adicionar à Tela de Início/u);
});
