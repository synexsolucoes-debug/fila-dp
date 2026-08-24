import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PRIVACY_REQUEST_DEADLINE_DAYS, isPrivacyRequest, leadInterestLabels, leadInterests } from "../lib/marketing.ts";

/**
 * §50: o pedido do titular precisa chegar em algum lugar identificável.
 *
 * A página de privacidade manda o titular pedir acesso, correção, anonimização
 * ou portabilidade pela página de Contato, e promete resposta em até 15 dias. O
 * formulário tinha cinco assuntos e nenhum era esse: o pedido chegava como
 * "outro", numa tabela chamada `fdp_marketing_leads`, listada no console sob
 * "Leads comerciais". Indistinguível de quem quer falar de preço, e sem nada
 * marcando o prazo.
 *
 * Conferido contra o produto de pé — e o primeiro ensaio devolveu **500**: o
 * CHECK do banco não conhecia o assunto novo. É o defeito que teria ido para
 * produção se eu tivesse confiado no tipo em vez de enviar o formulário.
 */

test("o titular tem um assunto próprio no formulário", () => {
  assert.ok((leadInterests as readonly string[]).includes("privacidade"));
  assert.match(leadInterestLabels.privacidade, /LGPD/u);
  assert.equal(isPrivacyRequest("privacidade"), true);
  assert.equal(isPrivacyRequest("planos"), false);
});

test("o banco aceita o assunto que o código oferece", async () => {
  // O CHECK precisa acompanhar a lista. Sem a migration, escolher o assunto
  // novo devolvia 500 a quem estava exercendo um direito.
  const migration = await readFile(new URL("../drizzle/postgres/0043_lead_privacy_interest.sql", import.meta.url), "utf8");
  for (const assunto of leadInterests) {
    assert.match(migration, new RegExp(`'${assunto}'`, "u"), `${assunto} fora do CHECK`);
  }
  const journal = JSON.parse(await readFile(new URL("../drizzle/postgres/meta/_journal.json", import.meta.url), "utf8")) as
    { entries: Array<{ tag: string }> };
  assert.ok(journal.entries.some((entry) => entry.tag === "0043_lead_privacy_interest"));
});

test("o console mostra os pedidos em aberto e a idade do mais antigo", async () => {
  const rota = await readFile(new URL("../app/api/platform/leads/route.ts", import.meta.url), "utf8");
  assert.match(rota, /WHERE interest = 'privacidade' AND status IN \('new', 'contacted'\)/u);
  // A idade vem do banco: contar no navegador tornaria o componente impuro e
  // usaria o relógio errado como referência do prazo.
  assert.match(rota, /EXTRACT\(DAY FROM now\(\) - min\(created_at\)\)/u);
  assert.match(rota, /deadlineDays: PRIVACY_REQUEST_DEADLINE_DAYS/u);

  const console_ = await readFile(new URL("../app/plataforma/features/BillingFeature.tsx", import.meta.url), "utf8");
  assert.match(console_, /function PrivacyRequestsNotice/u);
  assert.match(console_, /const vencido = dias >= data\.deadlineDays;/u);
  assert.doesNotMatch(console_, /Date\.now\(\) - new Date\(data\.oldestAt\)/u);
  // Vencido é anúncio, não decoração.
  assert.match(console_, /role=\{vencido \? "alert" : undefined\}/u);
});

test("o prazo do console é o mesmo que a política publicou", async () => {
  // Um número aqui e outro na página seriam dois compromissos diferentes.
  assert.equal(PRIVACY_REQUEST_DEADLINE_DAYS, 15);
  const pagina = await readFile(new URL("../app/privacidade/page.tsx", import.meta.url), "utf8");
  assert.match(pagina, new RegExp(`respondidos em até ${PRIVACY_REQUEST_DEADLINE_DAYS} dias`, "u"));
});

test("a fila só conta o que ainda está em aberto", async () => {
  // Pedido qualificado ou descartado já foi tratado; contá-lo faria o painel
  // acusar atraso permanente e ensinaria a ignorar o aviso.
  const rota = await readFile(new URL("../app/api/platform/leads/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(rota, /interest = 'privacidade' AND status IN \('new', 'contacted', 'qualified'/u);
  const migration = await readFile(new URL("../drizzle/postgres/0043_lead_privacy_interest.sql", import.meta.url), "utf8");
  assert.match(migration, /WHERE "interest" = 'privacidade' AND "status" IN \('new', 'contacted'\)/u);
});
