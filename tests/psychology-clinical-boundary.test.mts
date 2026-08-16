import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertNoClinicalData } from "../lib/auxiliary.ts";

/**
 * O módulo de psicólogos é administrativo e financeiro: quantidade de consultas,
 * valor por consulta, conferência e pagamento. Diagnóstico, prontuário, conteúdo
 * da consulta e anotação clínica não entram — nem no campo que parece inofensivo.
 *
 * A guarda existia e era aplicada na criação e na edição da consulta, e no ajuste
 * do fechamento. Faltava em dois campos livres que também ficam gravados:
 *
 *   - `canceled_reason`, escrito ao cancelar uma consulta;
 *   - `reopen_reason`, escrito ao reabrir um fechamento.
 *
 * Os dois exigem justificativa por escrito, que é exatamente onde alguém explica
 * o "porquê" e acaba registrando o motivo clínico.
 */

const sessionRoute = new URL("../app/api/payments/psychology/sessions/[id]/route.ts", import.meta.url);
const transitionRoute = new URL("../app/api/payments/psychology/closings/[id]/transition/route.ts", import.meta.url);

test("o motivo do cancelamento da consulta passa pela guarda clínica", async () => {
  const source = await readFile(sessionRoute, "utf8");
  assert.match(source, /const reason = requiredReason\(body\.reason, "CANCELLATION_REASON_REQUIRED"\);\s*\n\s*assertNoClinicalData\("psychology", reason\);/u);
});

test("o motivo da reabertura do fechamento passa pela guarda clínica", async () => {
  const source = await readFile(transitionRoute, "utf8");
  assert.match(source, /assertNoClinicalData/u);
  assert.match(source, /import \{ assertNoClinicalData \} from "@\/lib\/auxiliary"/u);
});

test("todo campo livre do módulo de psicologia é guardado", async () => {
  // Se uma rota nova de psicologia exigir justificativa e esquecer a guarda, o
  // módulo volta a aceitar dado clínico por uma porta lateral.
  const routes = [
    "../app/api/payments/psychology/sessions/route.ts",
    "../app/api/payments/psychology/sessions/[id]/route.ts",
    "../app/api/payments/psychology/closings/[id]/transition/route.ts",
    "../app/api/payments/psychology/closings/[id]/adjustments/route.ts",
  ];
  for (const route of routes) {
    const source = await readFile(new URL(route, import.meta.url), "utf8");
    if (!/requiredReason|administrativeNote/u.test(source)) continue;
    assert.match(source, /assertNoClinicalData\("psychology"/u, `${route} grava texto livre sem a guarda clínica`);
  }
});

test("a guarda aceita motivo administrativo e recusa conteúdo clínico", () => {
  // O que a operação escreve de verdade ao cancelar ou reabrir.
  for (const legitimo of [
    "Cancelada a pedido da empresa",
    "Reaberto: erro de digitação no valor",
    "Ajuste de sessão não comparecida",
    "Consulta duplicada na importação",
  ]) {
    assert.doesNotThrow(() => assertNoClinicalData("psychology", legitimo), `"${legitimo}" é motivo administrativo`);
  }

  for (const clinico of [
    "Cancelada — paciente iniciou tratamento",
    "Reaberto para corrigir diagnóstico informado",
    "Sessão sobre sintoma relatado",
    "Anexado ao prontuário",
    "Ajuste na medicação",
  ]) {
    assert.throws(() => assertNoClinicalData("psychology", clinico), /Dados clínicos/u, `"${clinico}" precisa ser recusado`);
  }
});

test("a guarda vale só para psicologia: benefícios e PJ têm outra natureza", () => {
  // Um benefício pode citar "tratamento" legitimamente (plano odontológico, por
  // exemplo). Aplicar a guarda a todos os módulos viraria recusa sem sentido.
  assert.doesNotThrow(() => assertNoClinicalData("benefits", "Reembolso de tratamento odontológico"));
  assert.doesNotThrow(() => assertNoClinicalData("contractors", "Nota referente a diagnóstico de sistema"));
});

test("o schema de psicologia não tem campo para conteúdo clínico", async () => {
  // A tabela guarda apenas o que a apuração precisa. Se alguém adicionar coluna
  // de conteúdo de consulta, este teste é o lugar onde a decisão aparece.
  const migration = await readFile(new URL("../drizzle/postgres/0018_payment_control_modules.sql", import.meta.url), "utf8");
  const sessions = migration.slice(migration.indexOf('CREATE TABLE "fdp_psychology_sessions"'));
  const body = sessions.slice(0, sessions.indexOf(");"));
  for (const proibido of ["diagnos", "prontuario", "prontuário", "clinical", "clinico", "clínico", "anamnese", "evolucao"]) {
    assert.doesNotMatch(body.toLowerCase(), new RegExp(proibido, "u"), `a tabela não pode ter coluna "${proibido}"`);
  }
  // O que ela tem é apuração: quantidade, valor unitário e total.
  assert.match(body, /session_quantity/u);
  assert.match(body, /unit_amount/u);
  assert.match(body, /total_amount/u);
});
