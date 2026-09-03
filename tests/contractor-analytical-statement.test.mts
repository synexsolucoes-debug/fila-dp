import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { contractorStatementTotals, generateContractorStatementsPdf, type ContractorStatement } from "../lib/contractor-batch-statement-pdf.ts";

const statement = await readFile(
  new URL(
    "../app/painel/features/payments/ContractorAnalyticalStatement.tsx",
    import.meta.url,
  ),
  "utf8",
);

const detail = await readFile(
  new URL(
    "../app/painel/features/payments/ContractorPaymentDetail.tsx",
    import.meta.url,
  ),
  "utf8",
);

const types = await readFile(
  new URL(
    "../app/painel/features/payments/payments.types.ts",
    import.meta.url,
  ),
  "utf8",
);

const api = await readFile(
  new URL(
    "../app/painel/features/payments/payments.api.ts",
    import.meta.url,
  ),
  "utf8",
);

const receiptPdf = await readFile(
  new URL("../lib/contractor-batch-statement-pdf.ts", import.meta.url),
  "utf8",
);

test("extrato PJ apresenta valores essenciais da conferencia", () => {
  assert.match(statement, /Total de proventos/u);
  assert.match(statement, /Total de descontos/u);
  assert.match(statement, /Líquido devido/u);
  assert.match(statement, /Complemento Caju/u);
  assert.match(statement, /Valor em Nota Fiscal/u);
  assert.match(statement, /Valor da NF recebida/u);
  assert.match(statement, /Diferença da NF/u);
  assert.match(statement, /Número da NF/u);
  assert.match(statement, /Status da conferência/u);
  assert.match(statement, /Acompanhamento da nota fiscal/u);
  assert.match(statement, /Não lançada/u);
  assert.match(statement, /Bloqueado pela nota/u);
  assert.match(statement, /invoicePaymentBlock/u);
});

test("extrato mostra somente complemento referente ao Caju", () => {
  assert.match(statement, /Complemento Caju/u);

  assert.doesNotMatch(statement, /Caju previsto/iu);
  assert.doesNotMatch(statement, /Caju realizado/iu);
  assert.doesNotMatch(statement, /Diferença Caju/iu);
});

test("proventos e descontos continuam analiticos", () => {
  assert.match(detail, /Proventos/u);
  assert.match(detail, /Descontos/u);
  assert.match(detail, /Valor contratual/u);
  assert.match(
    detail,
    /<ContractorAnalyticalStatement detail=\{detail\} \/>/u,
  );
  assert.match(detail, /Gerar recibo de pagamento/u);
});

test("CNPJ do PJ chega ao extrato", () => {
  assert.match(types, /taxId:\s*string/u);

  assert.match(
    api,
    /taxId:\s*text\(pick\(provider,\s*"taxId",\s*"tax_id"\)\)/u,
  );

  assert.match(statement, /formatCnpj\(detail\.provider\.taxId\)/u);
});

test("extrato pode ser exportado para CSV", () => {
  assert.match(statement, /Exportar extrato CSV/u);
  assert.match(statement, /text\/csv/u);
  assert.match(statement, /URL\.createObjectURL/u);
  assert.match(statement, /extrato-pj-/u);
});

test("novo PDF preserva os totais e remove lançamentos cancelados", async () => {
  const input: ContractorStatement = {
    company: {
      legalName: "LC Provedores de Acesso às Redes de Comunicação e Informática Ltda",
      tradeName: "OpyT",
      taxId: "43944672000320",
      address: "Rua 09, nº 1647, QD-E12 LT-11, Setor Marista - Goiânia - GO",
    },
    competence: "2026-05",
    issuedAt: new Date("2026-06-01T12:00:00-03:00"),
    contractor: {
      code: "PJ-001", legalName: "Prestador Exemplo Ltda", tradeName: "Prestador Exemplo",
      taxId: "12345678000190", contractReference: "CTR-2026-001", roleTitle: "Consultoria",
    },
    closing: {
      baseAmount: 6500, creditsAmount: 500, debitsAmount: 400, netAmount: 6600,
      invoiceExpectedAmount: 6000, complementAmount: 600, cajuAmount: 600,
      invoiceNumber: "123", invoiceReceivedAmount: 6000, invoiceStatus: "validated",
    },
    components: [
      { direction: "credit", description: "Bônus ativo", componentType: "bonus", amount: 500, status: "active" },
      { direction: "credit", description: "Bônus cancelado", componentType: "bonus", amount: 9999, status: "canceled" },
      { direction: "debit", description: "Plano de saúde", componentType: "health_plan", amount: 400, status: "active" },
    ],
  };
  const totals = contractorStatementTotals(input);
  assert.equal(totals.totalEarnings, 7000);
  assert.equal(totals.totalDiscounts, 400);
  assert.equal(totals.credits.length, 1);
  assert.equal(totals.debits.length, 1);
  const pdf = await generateContractorStatementsPdf([input]);
  assert.equal(new TextDecoder().decode(pdf.slice(0, 4)), "%PDF");
  assert.ok(pdf.byteLength > 2_000);
});

test("recibo traz marca OpyT, marca-d'água Vinculato e declaração com pagadora", () => {
  assert.match(receiptPdf, /drawOpytLogo/u);
  assert.match(receiptPdf, /drawWatermark/u);
  assert.match(receiptPdf, /vinculato-logo\.png/u);
  assert.match(receiptPdf, /RECEBI DA EMPRESA/u);
  assert.match(receiptPdf, /amountInWords/u);
  assert.match(receiptPdf, /QUITAÇÃO EXCLUSIVAMENTE/u);
});

test("emissão em lote inicia conferência, aprovação coletiva e documentos do contrato", async () => {
  const [route, approval, invoice, documents, migration, sections, dialogs] = await Promise.all([
    readFile(new URL("../app/api/payments/contractors/statements/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/contractors/closings/approve/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/contractors/closings/[id]/invoice/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/payments/contractors/[id]/documents/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/postgres/0053_contractor_documents.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/payments/ContractorSections.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/payments/PaymentDialogs.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(route, /component\.status = 'active'/u);
  assert.match(route, /tax_id, street, street_number/u);
  assert.match(route, /status IN \('open', 'reopened'\)/u);
  assert.match(route, /generateContractorStatementsPdf/u);
  assert.match(approval, /status IN \('review', 'approval'\)/u);
  assert.match(approval, /approved_by = \?/u);
  assert.match(invoice, /fdp_contractor_documents/u);
  assert.match(invoice, /getAttachmentsBucket/u);
  assert.match(documents, /contractors\.payments\.read/u);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /fdp_contractor_documents_workspace_provider_fk/u);
  assert.match(sections, /Aprovar todos/u);
  assert.match(sections, /Emitir recibos de pagamento/u);
  assert.match(sections, /onOpenDocuments/u);
  assert.match(dialogs, /name="invoiceFile"/u);
});

test("detalhamento do PJ permite baixar apenas o recibo daquela pessoa", async () => {
  const [receiptRoute, view] = await Promise.all([
    readFile(new URL("../app/api/payments/contractors/closings/[id]/receipt/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/payments/PaymentsView.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(receiptRoute, /contractors\.payments\.read/u);
  assert.match(receiptRoute, /requireCompanyAccess/u);
  assert.match(receiptRoute, /status = 'active'/u);
  assert.match(receiptRoute, /tax_id, street, street_number/u);
  assert.match(receiptRoute, /generateContractorStatementsPdf\(\[statement\]\)/u);
  assert.match(receiptRoute, /contractor_receipt\.downloaded/u);
  assert.doesNotMatch(receiptRoute, /UPDATE fdp_contractor_closings/u);
  assert.match(view, /closings\/\$\{closingId\}\/receipt/u);
  assert.match(view, /onDownloadReceipt/u);
});
