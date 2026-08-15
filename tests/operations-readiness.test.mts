import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evaluateBillingReadiness, type BillingReadinessInput } from "../lib/billing-readiness.ts";

const readyInput: BillingReadinessInput = {
  stripeSecretConfigured: true,
  stripeWebhookSecretConfigured: true,
  publicUrlConfigured: true,
  selfSignupEnabled: false,
  plans: [
    { code: "pro", status: "active", monthlyPriceCents: 29900, annualPriceCents: 299000, stripeMonthlyPriceId: "price_m", stripeAnnualPriceId: "price_a" },
  ],
  processedWebhookEvents: 3,
  failedWebhookEvents: 0,
  activeSubscriptions: 1,
  paidInvoices: 1,
};

test("a cobrança só é declarada pronta quando todos os bloqueios caem", () => {
  const ready = evaluateBillingReadiness(readyInput);
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.blockers, []);
  assert.deepEqual(ready.warnings, []);
  assert.match(ready.summary, /pronta para clientes pagantes/u);
});

test("cada bloqueio impede a declaração de prontidão isoladamente", () => {
  const cases: Array<[string, Partial<BillingReadinessInput>]> = [
    ["stripe_secret", { stripeSecretConfigured: false }],
    ["stripe_webhook_secret", { stripeWebhookSecretConfigured: false }],
    ["public_url", { publicUrlConfigured: false }],
    ["active_plans", { plans: [] }],
    ["webhook_proof", { processedWebhookEvents: 0 }],
    ["checkout_proof", { activeSubscriptions: 0 }],
  ];
  for (const [key, override] of cases) {
    const result = evaluateBillingReadiness({ ...readyInput, ...override });
    assert.equal(result.ready, false, `${key} deveria bloquear a prontidão`);
    assert.ok(result.blockers.includes(key), `${key} deveria aparecer entre os bloqueios`);
    assert.match(result.summary, /não está pronta/u);
    // Todo bloqueio explica o que fazer.
    const check = result.checks.find((item) => item.key === key)!;
    assert.ok(check.remedy && check.remedy.length > 10, `${key} precisa de orientação de correção`);
  }
});

test("plano ativo com preço mas sem identificador no provedor é bloqueio", () => {
  const result = evaluateBillingReadiness({
    ...readyInput,
    plans: [
      { code: "pro", status: "active", monthlyPriceCents: 29900, annualPriceCents: 0, stripeMonthlyPriceId: "", stripeAnnualPriceId: "" },
      { code: "enterprise", status: "draft", monthlyPriceCents: 99900, annualPriceCents: 0, stripeMonthlyPriceId: "", stripeAnnualPriceId: "" },
    ],
  });
  assert.equal(result.ready, false);
  assert.ok(result.blockers.includes("plan_prices"));
  const check = result.checks.find((item) => item.key === "plan_prices")!;
  // O rascunho não é cobrado e por isso não entra na acusação.
  assert.match(check.detail, /pro/u);
  assert.doesNotMatch(check.detail, /enterprise/u);
});

test("plano anual sem identificador anual também bloqueia", () => {
  const result = evaluateBillingReadiness({
    ...readyInput,
    plans: [{ code: "pro", status: "active", monthlyPriceCents: 29900, annualPriceCents: 299000, stripeMonthlyPriceId: "price_m", stripeAnnualPriceId: "" }],
  });
  assert.equal(result.ready, false);
  assert.ok(result.blockers.includes("plan_prices"));
});

test("falha de webhook e ausência de fatura paga são atenção, não bloqueio", () => {
  const result = evaluateBillingReadiness({ ...readyInput, failedWebhookEvents: 2, paidInvoices: 0 });
  assert.equal(result.ready, true);
  assert.deepEqual(result.warnings.sort(), ["invoice_proof", "webhook_failures"]);
  assert.match(result.summary, /ponto\(s\) de atenção/u);
});

test("cadastro público aberto com cobrança incompleta é sinalizado", () => {
  const risky = evaluateBillingReadiness({ ...readyInput, selfSignupEnabled: true, processedWebhookEvents: 0 });
  assert.equal(risky.ready, false);
  assert.equal(risky.signupWithoutBilling, true);

  const safe = evaluateBillingReadiness({ ...readyInput, selfSignupEnabled: true });
  assert.equal(safe.signupWithoutBilling, false);
});

test("a rota de prontidão é exclusiva da plataforma e não devolve segredo", async () => {
  const source = await readFile(new URL("../app/api/platform/billing-readiness/route.ts", import.meta.url), "utf8");
  assert.match(source, /requirePlatformAdmin/);
  assert.match(source, /withPlatformContext/);
  assert.match(source, /evaluateBillingReadiness/);
  // Apenas a presença da chave é avaliada; o valor nunca entra na resposta.
  assert.match(source, /Boolean\(String\(process\.env\.STRIPE_SECRET_KEY \?\? ""\)\.trim\(\)\)/);
  assert.doesNotMatch(source, /secretKey:|STRIPE_SECRET_KEY,/u);
});

test("o ensaio de restauração verifica conteúdo, estrutura e isolamento", async () => {
  const [script, seed, isolation] = await Promise.all([
    readFile(new URL("../scripts/rehearse-backup-restore.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/dr-seed.sql", import.meta.url), "utf8"),
    readFile(new URL("../scripts/dr-verify-isolation.sql", import.meta.url), "utf8"),
  ]);

  assert.match(script, /pg_dump/);
  assert.match(script, /pg_restore/);
  assert.match(script, /--exit-on-error/);
  // Não basta restaurar: a estrutura de segurança precisa sobreviver.
  assert.match(script, /pg_policies/);
  assert.match(script, /relforcerowsecurity/);
  assert.match(script, /pg_trigger/);
  assert.match(script, /pg_constraint/);
  assert.match(script, /ISOLAMENTO_OK/);
  assert.match(script, /closed payment closing is immutable/);
  // Falha em qualquer verificação reprova o ensaio.
  assert.match(script, /process\.exit\(1\)/);
  // O ensaio exige autorização explícita e banco descartável.
  assert.match(script, /FDP_ALLOW_EPHEMERAL_SCHEMA_TEST/);
  assert.match(script, /não são promessa de RTO em produção/u);

  // A semente cobre os dois clientes e um fechamento congelado.
  assert.match(seed, /dr-ws-a/);
  assert.match(seed, /dr-ws-b/);
  assert.match(seed, /'closed'/);
  // A verificação de isolamento usa papel sem superusuário — senão não prova nada.
  assert.match(isolation, /NOSUPERUSER NOBYPASSRLS/);
  assert.match(isolation, /vazamento apos restore/);
});

test("o ensaio restaura o schema de produção, não uma montagem própria", async () => {
  const script = await readFile(new URL("../scripts/rehearse-backup-restore.mjs", import.meta.url), "utf8");

  // O passo montava um script único com todas as migrations dentro de um
  // BEGIN/COMMIT e reordenava à mão os índices únicos de 0014–0017. Restaurar
  // aquilo provava que um schema inexistente em produção restaura, e o banco
  // restaurado saía sem histórico em `fdp_schema_migrations`.
  assert.match(script, /scripts", "migrate\.mjs/u, "as migrations precisam vir do executor de produção");
  assert.doesNotMatch(script, /CREATE UNIQUE INDEX/u, "a reordenação manual não deve voltar");
  assert.doesNotMatch(script, /script \+= "BEGIN/u);
});

test("o ensaio de restauração roda na CI, e não só quando alguém lembra", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

  // Uma prova de backup que depende de memória humana apodrece, e a primeira
  // notícia de que o dump não restaura seria no dia em que ele precisasse.
  assert.match(workflow, /npm run db:rehearse-restore/u);
  assert.match(workflow, /FDP_ALLOW_EPHEMERAL_SCHEMA_TEST: "true"/u);
  assert.match(workflow, /FDP_DR_ADMIN_DATABASE_URL/u);
});
