import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { capabilities, hasCapability } from "../lib/authorization.ts";
import { capabilityCatalog } from "../lib/capability-catalog.ts";
import { capabilityOwners } from "../lib/modules.ts";
import {
  assertChecklistComplete,
  checkInvoiceFile,
  compareInvoiceAmount,
  documentDigits,
  findDuplicateInvoice,
  invoiceChecklistItems,
  invoiceEventSummary,
  invoicePaymentBlock,
  invoiceRejectionReasonLabels,
  invoiceRejectionReasons,
  invoiceReviewStatusLabels,
  invoiceReviewStatuses,
  isConfirmed,
  matchesQuickFilter,
  readyForPayment,
  reviewStatusFor,
  sanitizeChecklist,
  sanitizeInvoiceFilename,
  sanitizeRequiredChecks,
  summarizeInvoiceCompetence,
  validateRejection,
} from "../lib/contractor-invoices.ts";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/* -------------------------------------------------------------------------- */
/* Comparação de valores (§8)                                                  */
/* -------------------------------------------------------------------------- */

test("a comparação de valores é feita em centavos e diz o sinal da divergência", () => {
  const menor = compareInvoiceAmount(6000, 5500);
  assert.equal(menor.difference, -500);
  assert.equal(menor.matches, false);

  const igual = compareInvoiceAmount(5800, 5800);
  assert.equal(igual.difference, 0);
  assert.equal(igual.matches, true);

  const maior = compareInvoiceAmount(6000, 6100.5);
  assert.equal(maior.difference, 100.5);

  // Em ponto flutuante, 6000 - 5500.01 devolve 499.99000000000024. Uma tela de
  // conferência que imprimisse isso destruiria a confiança em todo o resto do
  // número — por isso a conta é feita em inteiros.
  assert.equal(compareInvoiceAmount(6000, 5500.01).difference, -499.99);
  assert.equal(compareInvoiceAmount("6000.00", "5999.99").difference, -0.01);
});

test("valores iguais nunca significam nota aprovada", () => {
  // O §8 é explícito: não aprovar automaticamente só porque os valores batem.
  // A regra que decide a situação da nota não conhece o valor informado.
  assert.equal(reviewStatusFor({ expectedAmount: 6000, invoiceStatus: "received" }), "received");
  assert.equal(readyForPayment({ expectedAmount: 6000, reviewStatus: "received", policy: "required" }), false);

  const rota = "app/api/payments/contractors/invoices/[id]/review/route.ts";
  return source(rota).then((texto) => {
    // Aprovar é sempre uma ação pedida: a rota não deriva "approved" de
    // comparação de valores em lugar nenhum.
    assert.match(texto, /requiredPaymentEnum\(body\.action/u);
    assert.doesNotMatch(texto, /matches\s*(\?|&&)/u);
  });
});

/* -------------------------------------------------------------------------- */
/* Situação da conferência e liberação do pagamento (§10)                      */
/* -------------------------------------------------------------------------- */

test("a situação da conferência distingue quem não emite de quem ainda não enviou", () => {
  assert.equal(reviewStatusFor({ expectedAmount: 0, invoiceStatus: null }), "not_required");
  assert.equal(reviewStatusFor({ expectedAmount: 6000, invoiceStatus: null }), "awaiting_issue");
  // Nota substituída deixa o pagamento sem nota vigente: ele volta a aguardar.
  assert.equal(reviewStatusFor({ expectedAmount: 6000, invoiceStatus: "replaced" }), "awaiting_issue");
  assert.equal(reviewStatusFor({ expectedAmount: 6000, invoiceStatus: "approved" }), "approved");
  assert.equal(reviewStatusFor({ expectedAmount: 6000, invoiceStatus: "correction_requested" }), "correction_requested");

  // Toda situação tem nome em português: a tela não depende de cor (§4).
  for (const status of invoiceReviewStatuses) {
    assert.ok(invoiceReviewStatusLabels[status], `${status} sem rótulo`);
  }
});

test("o pagamento só é liberado com nota aprovada, e a recusa diz por quê", () => {
  const required = { expectedAmount: 6000, policy: "required" as const };
  assert.equal(invoicePaymentBlock({ ...required, reviewStatus: "approved" }), "");
  assert.match(invoicePaymentBlock({ ...required, reviewStatus: "awaiting_issue" }), /ainda não foi enviada/u);
  assert.match(invoicePaymentBlock({ ...required, reviewStatus: "under_review" }), /aguardando conferência/u);
  assert.match(invoicePaymentBlock({ ...required, reviewStatus: "rejected" }), /rejeitada/u);

  // Quem não emite nota nunca é travado por ela.
  assert.equal(invoicePaymentBlock({ expectedAmount: 0, reviewStatus: "not_required", policy: "required" }), "");
  // E o grupo pode configurar que a nota não trava o pagamento (§10).
  assert.equal(invoicePaymentBlock({ expectedAmount: 6000, reviewStatus: "awaiting_issue", policy: "optional" }), "");
});

test("a rota de transição usa a mesma regra da tela, e não uma condição própria", async () => {
  const transition = await source("app/api/payments/contractors/closings/[id]/transition/route.ts");
  assert.match(transition, /invoicePaymentBlock\(\{/u);
  assert.match(transition, /loadInvoicePolicy\(d1, workspace\.id\)/u);
  assert.match(transition, /INVOICE_APPROVAL_REQUIRED/u);

  // O painel de pagamentos mostra o mesmo bloqueio, calculado no mesmo lugar.
  const overview = await source("app/api/payments/overview/route.ts");
  assert.match(overview, /invoice_payment_block/u);
  assert.match(overview, /invoicePaymentBlock\(\{/u);
});

/* -------------------------------------------------------------------------- */
/* Indicadores e filtros (§3, §13, §18)                                        */
/* -------------------------------------------------------------------------- */

const competencia = [
  { expectedAmount: 5800, reviewStatus: "approved", informedAmount: 5800, hasInvoice: true },
  { expectedAmount: 6000, reviewStatus: "awaiting_issue", informedAmount: 0, hasInvoice: false },
  { expectedAmount: 6000, reviewStatus: "under_review", informedAmount: 5500, hasInvoice: true },
  { expectedAmount: 4000, reviewStatus: "rejected", informedAmount: 4200, hasInvoice: true },
  // Prestador sem nota a emitir: não conta em lugar nenhum.
  { expectedAmount: 0, reviewStatus: "not_required", informedAmount: 0, hasInvoice: false },
];

test("os indicadores da competência contam só quem precisa emitir nota", () => {
  const resumo = summarizeInvoiceCompetence(competencia);
  assert.equal(resumo.requiredCount, 4, "quem não emite nota entrou na conta");
  assert.equal(resumo.receivedCount, 3);
  assert.equal(resumo.pendingCount, 1);
  assert.equal(resumo.awaitingReviewCount, 1);
  assert.equal(resumo.approvedCount, 1);
  assert.equal(resumo.rejectedCount, 1);
  assert.equal(resumo.divergentCount, 2, "as notas com valor diferente do esperado");
  assert.equal(resumo.readyCount, 1);
  assert.equal(resumo.expectedAmount, 21800);
  assert.equal(resumo.approvedAmount, 5800);
  // 1 de 4 aprovadas: o progresso considera só os obrigados (§18).
  assert.equal(resumo.progress, 25);
});

test("competência sem nota exigida não inventa progresso", () => {
  const vazia = summarizeInvoiceCompetence([{ expectedAmount: 0, reviewStatus: "not_required", informedAmount: 0, hasInvoice: false }]);
  assert.equal(vazia.requiredCount, 0);
  assert.equal(vazia.progress, 0);
});

test("cada filtro rápido recorta o que promete", () => {
  const conta = (filtro: Parameters<typeof matchesQuickFilter>[1]) =>
    competencia.filter((row) => matchesQuickFilter(row, filtro)).length;
  assert.equal(conta("all"), 5);
  assert.equal(conta("missing"), 1);
  assert.equal(conta("received"), 3);
  assert.equal(conta("awaiting_review"), 1);
  assert.equal(conta("approved"), 1);
  assert.equal(conta("rejected"), 1);
  assert.equal(conta("divergent"), 2);
  assert.equal(conta("ready"), 1);
  assert.equal(conta("pending"), 3, "pendente é tudo que ainda não está aprovado");
});

/* -------------------------------------------------------------------------- */
/* Duplicidade (§16)                                                           */
/* -------------------------------------------------------------------------- */

test("a duplicidade compara emissor, número e série — e ignora nota já recusada", () => {
  const existentes = [
    { id: "a", competence: "2026-07", invoiceNumber: "1245", series: "1", issuerDocument: "26.016.500/0001-05", providerId: "p1", status: "approved" },
    { id: "b", competence: "2026-08", invoiceNumber: "9999", series: "", issuerDocument: "11111111111111", providerId: "p2", status: "rejected" },
  ];

  const igual = findDuplicateInvoice(existentes, {
    invoiceNumber: "1245", series: "1", issuerDocument: "26016500000105", providerId: "p1",
  });
  assert.equal(igual?.id, "a", "a pontuação do CNPJ não pode esconder a duplicidade");

  assert.equal(findDuplicateInvoice(existentes, {
    invoiceNumber: "1245", series: "2", issuerDocument: "26016500000105", providerId: "p1",
  }), null, "série diferente é outra nota");

  // Nota recusada pode ser reemitida com o mesmo número depois de corrigida.
  assert.equal(findDuplicateInvoice(existentes, {
    invoiceNumber: "9999", series: "", issuerDocument: "11111111111111", providerId: "p2",
  }), null);

  assert.equal(documentDigits("26.016.500/0001-05"), "26016500000105");
});

test("o banco também impede duas notas iguais valendo ao mesmo tempo", async () => {
  const migration = await source("drizzle/postgres/0077_contractor_invoice_control.sql");
  assert.match(migration, /fdp_contractor_invoices_duplicate_uq/u);
  assert.match(migration, /WHERE "superseded_at" IS NULL AND "status" NOT IN \('rejected', 'canceled', 'replaced'\)/u);
  // E um pagamento tem uma nota vigente por vez.
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "fdp_contractor_invoices_current_uq"/u);
});

/* -------------------------------------------------------------------------- */
/* Recusa, checklist e histórico (§6, §7, §24)                                 */
/* -------------------------------------------------------------------------- */

test("recusar exige motivo, e “Outro” exige descrição", () => {
  assert.throws(() => validateRejection("", ""), /motivo/iu);
  assert.throws(() => validateRejection("motivo_inventado", ""), /motivo/iu);
  assert.throws(() => validateRejection("other", "abc"), /pelo menos 5 caracteres/u);
  assert.deepEqual(validateRejection("amount_mismatch", ""), { reason: "amount_mismatch", detail: "" });
  assert.deepEqual(validateRejection("other", "faltou o número do contrato"),
    { reason: "other", detail: "faltou o número do contrato" });

  for (const motivo of invoiceRejectionReasons) {
    assert.ok(invoiceRejectionReasonLabels[motivo], `${motivo} sem rótulo em português`);
  }
});

test("o checklist só aceita itens conhecidos e bloqueia a aprovação quando o grupo o exige", () => {
  assert.deepEqual(sanitizeChecklist({ amount: true, inventado: true, readable: "sim" }),
    { amount: true, readable: false });
  assert.deepEqual(sanitizeRequiredChecks(["amount", "amount", "inventado"]), ["amount"]);
  // Uma chave inventada como obrigatória travaria toda aprovação para sempre.
  assert.deepEqual(sanitizeRequiredChecks(["nao_existe"]), []);

  assert.throws(() => assertChecklistComplete({ amount: true }, ["amount", "competence"]), /Competência confere/u);
  assert.doesNotThrow(() => assertChecklistComplete({ amount: true, competence: true }, ["amount", "competence"]));
  // Sem exigência configurada, o checklist é apoio e não trava nada.
  assert.doesNotThrow(() => assertChecklistComplete({}, []));

  assert.equal(invoiceChecklistItems.length, 8);
});

test("o histórico é escrito em português, com quem fez e o que mudou", () => {
  /* O valor é formatado pelo Intl, que separa "R$" do número com espaço
     inquebrável. Escrever a string esperada à mão com espaço comum faria o
     teste reprovar por um caractere invisível — o valor esperado sai do mesmo
     formatador. */
  const money = (value: number) =>
    new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);

  assert.equal(
    invoiceEventSummary({ action: "uploaded", actorName: "João", invoiceNumber: "1425", amount: 5800 }),
    `NF 1425 anexada por João. Valor informado: ${money(5800)}.`,
  );
  assert.equal(
    invoiceEventSummary({ action: "approved", actorName: "Maria", invoiceNumber: "1425", amount: 5800 }),
    `NF 1425 aprovada por Maria. Valor aprovado: ${money(5800)}.`,
  );
  assert.equal(
    invoiceEventSummary({ action: "rejected", actorName: "Carlos", invoiceNumber: "1425", reason: "Valor incorreto" }),
    "NF 1425 rejeitada por Carlos. Motivo: Valor incorreto.",
  );
  assert.equal(
    invoiceEventSummary({ action: "replaced", actorName: "Ana", invoiceNumber: "1425", replacementNumber: "1458" }),
    "NF 1425 substituída pela NF 1458 por Ana.",
  );
});

/* -------------------------------------------------------------------------- */
/* Arquivo (§29)                                                               */
/* -------------------------------------------------------------------------- */

test("o arquivo da nota é conferido por tipo, extensão e tamanho", () => {
  assert.deepEqual(checkInvoiceFile({ name: "nota.pdf", type: "application/pdf", size: 1024 }),
    { contentType: "application/pdf", extension: "pdf" });
  assert.deepEqual(checkInvoiceFile({ name: "nota.XML", type: "text/xml", size: 900 }),
    { contentType: "text/xml", extension: "xml" });

  // Confiar no tipo declarado pelo navegador é entregar a decisão de segurança
  // a quem envia: a extensão precisa combinar.
  assert.throws(() => checkInvoiceFile({ name: "nota.pdf.exe", type: "application/pdf", size: 10 }),
    /PDF, JPG, PNG, WEBP ou XML/u);
  assert.throws(() => checkInvoiceFile({ name: "nota.html", type: "text/html", size: 10 }),
    /PDF, JPG, PNG, WEBP ou XML/u);
  assert.throws(() => checkInvoiceFile({ name: "nota.pdf", type: "application/pdf", size: 21 * 1024 * 1024 }),
    /20 MB/u);
  assert.throws(() => checkInvoiceFile({ name: "nota.pdf", type: "application/pdf", size: 0 }), /vazio/u);
});

test("o nome do arquivo é higienizado sem nunca ficar vazio", () => {
  // A travessia deixa de existir: guarda-se o nome, nunca o caminho.
  assert.equal(sanitizeInvoiceFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeInvoiceFilename("C:\\notas\\nf.pdf"), "nf.pdf");
  assert.equal(sanitizeInvoiceFilename('nota"1245.pdf'), "nota_1245.pdf");
  assert.equal(sanitizeInvoiceFilename("nota\r\n.pdf"), "nota.pdf");
  assert.equal(sanitizeInvoiceFilename(""), "nota-fiscal");
  assert.equal(sanitizeInvoiceFilename("..."), "nota-fiscal");
});

test("a confirmação vale vinda do JSON e do formulário", () => {
  // O mesmo campo chega como `true` e como "true"; comparar só com o booleano
  // falharia justamente no envio com arquivo.
  assert.equal(isConfirmed(true), true);
  assert.equal(isConfirmed("true"), true);
  assert.equal(isConfirmed("false"), false);
  assert.equal(isConfirmed(undefined), false);
});

test("o documento só é exibido no navegador quando não pode carregar script", async () => {
  const rota = await source("app/api/payments/contractors/documents/[id]/route.ts");
  assert.match(rota, /isPreviewableInvoiceType/u);
  assert.match(rota, /X-Content-Type-Options/u);
  assert.match(rota, /Content-Security-Policy/u);
  assert.match(rota, /Cache-Control", "private, no-store/u);
  // A entrega continua exigindo tenant, permissão e empresa antes do arquivo.
  assert.match(rota, /requireCompanyAccess\(d1, workspace\.id, user\.id, workspace\.role, document\.company_id\)/u);
  assert.match(rota, /WHERE workspace_id = \? AND id = \?/u);
});

/* -------------------------------------------------------------------------- */
/* Permissões (§21)                                                            */
/* -------------------------------------------------------------------------- */

test("as capacidades de nota fiscal existem, estão descritas e têm módulo dono", () => {
  const esperadas = [
    "invoice.read", "invoice.create", "invoice.upload", "invoice.update",
    "invoice.review", "invoice.approve", "invoice.reject", "invoice.replace", "invoice.export",
  ] as const;
  for (const capability of esperadas) {
    assert.ok((capabilities as readonly string[]).includes(capability), `${capability} fora do catálogo`);
    assert.ok(capabilityCatalog[capability]?.label, `${capability} sem descrição para quem administra`);
    if (capability !== "invoice.read") {
      assert.ok(capabilityOwners.has(capability), `${capability} sem módulo dono`);
    }
  }
});

test("o observador lê a nota e não decide nada sobre ela", () => {
  assert.equal(hasCapability("observer", "invoice.read"), true);
  for (const capability of ["invoice.create", "invoice.approve", "invoice.reject", "invoice.replace"] as const) {
    assert.equal(hasCapability("observer", capability), false, `observador não deveria poder ${capability}`);
  }
  assert.equal(hasCapability("guest", "invoice.read"), false);

  // O analista opera a conferência inteira; substituir nota aprovada fica com
  // quem administra, porque reescreve documento que já liberou pagamento.
  assert.equal(hasCapability("member", "invoice.approve"), true);
  assert.equal(hasCapability("member", "invoice.replace"), false);
  assert.equal(hasCapability("admin", "invoice.replace"), true);
});

test("cada rota de nota exige a permissão da ação que executa, no servidor", async () => {
  const [lista, detalhe, review, lote, policy] = await Promise.all([
    source("app/api/payments/contractors/invoices/route.ts"),
    source("app/api/payments/contractors/invoices/[id]/route.ts"),
    source("app/api/payments/contractors/invoices/[id]/review/route.ts"),
    source("app/api/payments/contractors/invoices/batch/route.ts"),
    source("app/api/payments/contractors/invoices/policy/route.ts"),
  ]);

  assert.match(lista, /requireCapability\(workspace, "invoice\.read"\)/u);
  assert.match(lista, /requireCapability\(workspace, "invoice\.create"\)/u);
  assert.match(lista, /requireCapability\(workspace, "invoice\.upload"\)/u);
  assert.match(lista, /requireCapability\(workspace, "invoice\.replace"\)/u);
  assert.match(detalhe, /requireCapability\(workspace, "invoice\.update"\)/u);
  assert.match(policy, /requireCapability\(workspace, "invoice\.update"\)/u);
  // Aprovar e recusar têm permissões distintas, resolvidas por um mapa único.
  assert.match(review, /invoiceReviewCapability\[action\]/u);
  assert.match(lote, /invoiceReviewCapability\[action\]/u);

  const service = await source("lib/contractor-invoice-service.ts");
  assert.match(service, /approve: "invoice\.approve"/u);
  assert.match(service, /reject: "invoice\.reject"/u);
  assert.match(service, /start_review: "invoice\.review"/u);
});

/* -------------------------------------------------------------------------- */
/* Multi-tenancy (§22)                                                         */
/* -------------------------------------------------------------------------- */

test("as tabelas de nota nascem com workspace, RLS forçada e política de isolamento", async () => {
  const migration = await source("drizzle/postgres/0077_contractor_invoice_control.sql");
  for (const table of ["fdp_contractor_invoices", "fdp_contractor_invoice_events"]) {
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`, "u"));
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`, "u"));
    assert.match(migration,
      new RegExp(`CREATE POLICY "${table}_workspace_isolation" ON "${table}"[\\s\\S]*?USING \\("workspace_id" = NULLIF\\(current_setting\\('app\\.workspace_id', true\\), ''\\)\\)`, "u"));
  }
  // O vínculo obrigatório do §22: workspace, empresa, competência, pagamento e
  // prestador. Documento sem esses vínculos não pode existir.
  for (const column of ['"workspace_id" text', '"company_id" text NOT NULL', '"provider_id" text NOT NULL',
    '"payroll_cycle_id" text NOT NULL', '"closing_id" text NOT NULL', '"competence" text NOT NULL']) {
    assert.ok(migration.includes(column), `coluna ausente: ${column}`);
  }
});

test("toda consulta de nota é recortada pelo grupo, ao lado da RLS", async () => {
  const service = await source("lib/contractor-invoice-service.ts");
  const consultas = service.match(/FROM fdp_contractor_invoice[\s\S]*?(?=`\))/gu) ?? [];
  assert.ok(consultas.length > 0, "nenhuma consulta encontrada para conferir");
  for (const consulta of consultas) {
    assert.match(consulta, /workspace_id = \?/u, `consulta sem recorte de grupo: ${consulta.slice(0, 90)}`);
  }
  // E o serviço nunca resolve o grupo por conta própria: ele recebe o do
  // contexto autenticado.
  assert.doesNotMatch(service, /current_setting\('app\.workspace_id'/u);
});

test("o isolamento é provado no mesmo ensaio que roda contra o banco de verdade", async () => {
  // O ensaio percorre toda tabela com `workspace_id`; as duas novas entram nele
  // sem lista à parte, e reprovariam se nascessem sem RLS.
  const script = await source("scripts/verify-tenant-isolation.mjs");
  assert.match(script, /col\.column_name = 'workspace_id'/u);
  assert.match(script, /toda tabela com workspace_id tem RLS forçada/u);
});

/* -------------------------------------------------------------------------- */
/* Substituição e histórico (§15, §24, §30)                                    */
/* -------------------------------------------------------------------------- */

test("substituir preserva a nota anterior em vez de sobrescrevê-la", async () => {
  const service = await source("lib/contractor-invoice-service.ts");
  /* A anterior sai de cena antes de a nova entrar — o índice só admite uma
     nota vigente por pagamento — e o vínculo para a substituta é escrito
     depois dela existir, porque a chave estrangeira é conferida na hora. A
     ordem foi encontrada rodando o ensaio contra um PostgreSQL de verdade. */
  assert.match(service, /superseded_at = now\(\), updated_at = now\(\)/u);
  assert.match(service, /SET replaced_by_invoice_id = \?, updated_at = now\(\)/u);
  const inserir = service.indexOf("INSERT INTO fdp_contractor_invoices");
  const vincular = service.indexOf("SET replaced_by_invoice_id = ?");
  assert.ok(inserir > 0 && vincular > inserir,
    "o vínculo com a substituta precisa ser escrito depois de ela existir");
  // E nada de UPDATE que reescreva número e valor da nota vigente no lugar.
  assert.doesNotMatch(service, /DELETE FROM fdp_contractor_invoices/u);
  assert.match(service, /INSERT INTO fdp_contractor_invoices/u);
  // Os dois eventos entram no mesmo lote da mudança que os originou.
  assert.match(service, /prepareInvoiceEvent\(d1, \{[\s\S]*?action: "replaced"/u);
  assert.match(service, /await d1\.batch\(statements\)/u);

  const migration = await source("drizzle/postgres/0077_contractor_invoice_control.sql");
  // Excluir nota aprovada não é uma operação que exista: não há DELETE nem
  // cascata a partir do fechamento (§30).
  assert.doesNotMatch(migration, /"fdp_contractor_invoices_closing_fk"[\s\S]{0,120}ON DELETE CASCADE/u);
});

test("a nota aprovada não é editada: corrigi-la passa por rejeitar e substituir", async () => {
  const detalhe = await source("app/api/payments/contractors/invoices/[id]/route.ts");
  assert.match(detalhe, /INVOICE_ALREADY_APPROVED/u);
  assert.match(detalhe, /AND superseded_at IS NULL AND status <> 'approved'/u);
});

test("toda decisão sobre a nota entra na auditoria estruturada", async () => {
  const [lista, review, lote] = await Promise.all([
    source("app/api/payments/contractors/invoices/route.ts"),
    source("app/api/payments/contractors/invoices/[id]/review/route.ts"),
    source("app/api/payments/contractors/invoices/batch/route.ts"),
  ]);
  assert.match(lista, /action: "contractor_invoice\.registered"/u);
  assert.match(review, /action: `contractor_invoice\.\$\{result\.status\}`/u);
  // Auditoria por nota, e não por lote: é a nota que precisa ser auditável.
  assert.match(lote, /action: `contractor_invoice\.\$\{result\.status\}`/u);
  assert.match(lote, /batch: true, batchSize: ids\.length/u);
  for (const texto of [lista, review, lote]) {
    assert.match(texto, /requestId: request\.headers\.get\("x-fila-dp-request-id"\)/u);
  }
});

test("a ação em lote exige confirmação explícita e não interrompe no primeiro erro", async () => {
  const lote = await source("app/api/payments/contractors/invoices/batch/route.ts");
  assert.match(lote, /INVOICE_BATCH_CONFIRMATION_REQUIRED/u);
  assert.match(lote, /body\.confirm !== true/u);
  assert.match(lote, /INVOICE_BATCH_TOO_LARGE/u);
  assert.match(lote, /failed\.push\(\{/u);
  // O lote reusa a conferência individual: aprovar em lote o que não se
  // aprovaria uma a uma é o risco que a ação em lote cria.
  assert.match(lote, /reviewInvoice\(d1, \{/u);
});

/* -------------------------------------------------------------------------- */
/* A lista nasce do pagamento (§11) e não duplica cálculo (§9)                 */
/* -------------------------------------------------------------------------- */

test("quem precisa emitir nota sai do próprio pagamento da competência", async () => {
  const service = await source("lib/contractor-invoice-service.ts");
  assert.match(service, /FROM fdp_contractor_closings c/u);
  assert.match(service, /LEFT JOIN fdp_contractor_invoices i/u,
    "o pagamento sem nota é a linha mais importante da tela e um INNER JOIN a esconderia");
  assert.match(service, /c\.invoice_expected_amount/u);
  // Não existe cadastro paralelo de "quem emite nota".
  assert.doesNotMatch(service, /CREATE TABLE/u);
});

test("o valor esperado da nota vem do cálculo PJ, não de uma segunda conta", async () => {
  const rules = await source("lib/contractor-invoices.ts");
  // O módulo de notas não recalcula limite, base, créditos nem complemento: ele
  // recebe o valor esperado pronto. (O nome da função do cálculo aparece no
  // comentário do arquivo, que é justamente onde a decisão está registrada —
  // por isso a busca é por chamada, não por menção.)
  assert.doesNotMatch(rules, /calculateContractorClosing\(|resolveInvoiceLimit\(/u);
  const service = await source("lib/contractor-invoice-service.ts");
  assert.match(service, /invoice_expected_amount, "Nota esperada"/u);
  // E o valor conferido é congelado no envio: reapurar depois não reescreve o
  // que já foi olhado.
  assert.match(service, /expected_amount/u);
  const payments = await source("lib/payment-service.ts");
  assert.match(payments, /invoice_review_status = CASE/u,
    "reapurar precisa ajustar a situação de quem ainda não tem nota");
});

/* -------------------------------------------------------------------------- */
/* Interface (§2, §5, §12, §13, §25, §26)                                      */
/* -------------------------------------------------------------------------- */

test("a aba de Notas Fiscais existe no fluxo de Pagamentos → Competências", async () => {
  const [secoes, rotas, navegacao, casca] = await Promise.all([
    source("app/painel/features/payments/contractor-sections.ts"),
    source("lib/panel-routes.ts"),
    source("lib/process-navigation.ts"),
    source("app/painel/WorkspaceApp.tsx"),
  ]);
  assert.match(secoes, /id: "contractorInvoices",\s*\n\s*label: "Notas Fiscais"/u);
  assert.match(rotas, /contractorInvoices: "pj\/notas-fiscais"/u);
  assert.match(navegacao, /"contractorInvoices"/u);
  assert.match(casca, /\n {2}contractorInvoices: \{/u, "o destino precisa de porta no menu do painel");
});

test("a tela traz visualizador interno, filtros, estados vazios e exportação", async () => {
  const [tela, gaveta, envio] = await Promise.all([
    source("app/painel/features/payments/ContractorInvoicesSection.tsx"),
    source("app/painel/features/payments/InvoiceReviewDrawer.tsx"),
    source("app/painel/features/payments/InvoiceUploadDialog.tsx"),
  ]);

  // §5: conferir sem baixar o arquivo.
  assert.match(gaveta, /<iframe/u);
  assert.match(gaveta, /disposition=inline/u);
  // §7 e §6: checklist e as três decisões.
  assert.match(gaveta, /invoiceChecklistItems\.map/u);
  assert.match(gaveta, /Aprovar nota/u);
  assert.match(gaveta, /Rejeitar nota/u);
  assert.match(gaveta, /Solicitar correção/u);
  // §24: o histórico aparece para quem confere.
  assert.match(gaveta, /Histórico/u);
  assert.match(gaveta, /Versões desta nota/u);

  // §13 e §12: filtros rápidos e busca.
  assert.match(tela, /invoiceQuickFilters\.map/u);
  assert.match(tela, /Nome, razão social, CPF\/CNPJ ou número da NF/u);
  // §26: os dois estados vazios pedidos, com texto diferente.
  assert.match(tela, /Nenhuma Nota Fiscal necessária nesta competência/u);
  assert.match(tela, /Nenhuma Nota Fiscal recebida/u);
  // §27: alertas, sem excesso.
  assert.match(tela, /prestador\(es\) ainda não enviaram nota fiscal/u);
  // §20: exportação, atrás da permissão.
  assert.match(tela, /permissions\?\.export/u);
  assert.match(tela, /contractor-invoices/u);
  // §18: progresso da conferência.
  assert.match(tela, /role="progressbar"/u);

  // §8 na origem: a divergência aparece enquanto se digita o valor.
  assert.match(envio, /Divergência de/u);
  assert.match(envio, /Valor confere com o esperado/u);
  // §16: o alerta de duplicidade com confirmação explícita.
  assert.match(envio, /Possível nota fiscal duplicada/u);
});

test("a situação da nota aparece também na tela de pagamentos (§10)", async () => {
  const secoes = await source("app/painel/features/payments/ContractorSections.tsx");
  assert.match(secoes, /invoiceReviewStatusLabels/u);
  assert.match(secoes, /row\.invoicePaymentBlock \? "Aguardando NF" : "Pronto para pagamento"/u);
  // E a competência mostra o retrato das notas sem abrir pagamento por pagamento (§17).
  assert.match(secoes, /invoiceSummary\.approvedCount/u);
});

test("o relatório da competência traz as duas pontas de cada nota (§20)", async () => {
  const reports = await source("lib/payment-reports.ts");
  assert.match(reports, /"contractor-invoices": \{/u);
  assert.match(reports, /capability: "invoice\.export"/u);
  for (const coluna of ["prestador", "cnpj", "nf_numero", "data_emissao", "valor_esperado", "valor_nf",
    "diferenca", "status_nf", "data_recebimento", "data_aprovacao", "responsavel_aprovacao", "status_pagamento"]) {
    assert.ok(reports.includes(`"${coluna}"`), `coluna ausente no relatório: ${coluna}`);
  }
  // O recorte por empresa continua valendo, como em todo relatório do módulo.
  assert.match(reports, /companyColumn: "c\.company_id"/u);
});
