/**
 * Ensaio do controle de notas fiscais contra um PostgreSQL real, pelo código
 * que o produto executa.
 *
 * `scripts/contractor-invoices-db-rehearsal.sql` prova o que o banco garante:
 * constraints, índices e RLS. Este aqui prova o que só o caminho de execução
 * responde — que registrar, substituir e conferir uma nota, chamando as mesmas
 * funções que as rotas chamam, deixa o pagamento no estado certo.
 *
 * As funções vêm importadas, não reescritas: um ensaio que refaz a gravação
 * prova a cópia e deixa o produto sem prova. Foi assim que a ordem errada dos
 * comandos da substituição apareceu — a chave estrangeira da nota anterior
 * apontava para uma linha que ainda não existia, e nenhum teste de unidade
 * poderia ver isso.
 *
 * Uso:
 *   DATABASE_URL="postgres://…" FDP_DB_DRIVER=pg \
 *   node --experimental-strip-types scripts/rehearse-contractor-invoices.mjs
 *
 * O banco precisa ter as migrations aplicadas. Tudo o que o ensaio escreve fica
 * dentro de um grupo próprio, criado e apagado por ele.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { getScopedD1 } from "../db/index.ts";
import {
  findInvoice,
  listClosingInvoices,
  listInvoiceEvents,
  listInvoicePanel,
  loadInvoicePolicy,
  registerInvoice,
  reviewInvoice,
} from "../lib/contractor-invoice-service.ts";
import { invoicePaymentBlock, summarizeInvoiceCompetence } from "../lib/contractor-invoices.ts";

const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!databaseUrl?.startsWith("postgres")) {
  throw new Error("Defina DATABASE_URL com uma conexão PostgreSQL antes de rodar o ensaio.");
}

const workspaceId = `ws-nf-${randomUUID().slice(0, 8)}`;
const userId = `${workspaceId}-user`;
const companyId = `${workspaceId}-co`;
const cycleId = `${workspaceId}-cy`;
const providerId = `${workspaceId}-pj`;
const closingId = `${workspaceId}-ccl`;
const competence = "2099-08";

const d1 = getScopedD1({ workspaceId, userId });
/* A semente vai pelo driver direto, e não pelo adaptador do produto.
 *
 * Não é preciosismo: `fdp_workspace_members` é uma das três tabelas sem RLS, e
 * o produto garante o recorte dela pela cláusula `WHERE` de cada consulta —
 * há um teste que reprova qualquer consulta nova sem esse filtro. Um INSERT de
 * semente não tem `WHERE` e entraria naquela lista como exceção sem motivo,
 * enfraquecendo a barreira para todo mundo. O código sob ensaio continua sendo
 * chamado pelo adaptador de verdade; o que muda de caminho é só o cenário.
 */
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });

async function comTenant(executar) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // A política de RLS lê esta variável; sem ela o ensaio não enxerga o que
    // acabou de escrever, e o resultado vazio pareceria aprovação.
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    await executar(client);
    await client.query("COMMIT");
  } catch (erro) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw erro;
  } finally {
    client.release();
  }
}

const falhas = [];
const conferir = (nome, condicao, detalhe = "") => {
  if (condicao) console.log(`✓ ${nome}`);
  else {
    falhas.push(`${nome}${detalhe ? ` — ${detalhe}` : ""}`);
    console.error(`✗ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
};

function semear() {
  return comTenant(async (client) => {
    await client.query("INSERT INTO fdp_users (id, email, name) VALUES ($1, $2, 'Conferente do ensaio')",
      [userId, `${workspaceId}@ensaio.test`]);
    await client.query("INSERT INTO fdp_workspaces (id, name, slug, owner_user_id) VALUES ($1, $2, $3, $4)",
      [workspaceId, "Grupo do ensaio", workspaceId, userId]);
    await client.query("INSERT INTO fdp_workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')",
      [workspaceId, userId]);
    await client.query(`INSERT INTO fdp_companies (id, workspace_id, legal_name, trade_name, tax_id)
      VALUES ($1, $2, 'Empresa do ensaio', 'Ensaio', '11222333000181')`, [companyId, workspaceId]);
    await client.query(`INSERT INTO fdp_payroll_cycles (id, workspace_id, company_id, competence, status, created_by)
      VALUES ($1, $2, $3, $4, 'open', $5)`, [cycleId, workspaceId, companyId, competence, userId]);
    await client.query(`INSERT INTO fdp_auxiliary_providers (id, workspace_id, provider_type, code, legal_name, tax_id)
      VALUES ($1, $2, 'contractor', 'XPTO', 'Empresa XPTO LTDA', '26016500000105')`, [providerId, workspaceId]);
    await client.query(`INSERT INTO fdp_contractor_profiles
        (provider_id, workspace_id, company_id, base_amount, complement_method, updated_by)
      VALUES ($1, $2, $3, 6000, 'caju_saldo_livre', $4)`, [providerId, workspaceId, companyId, userId]);
    // O cenário §32 do produto: nota esperada de R$ 6.000,00.
    await client.query(`INSERT INTO fdp_contractor_closings (id, workspace_id, company_id, provider_id, payroll_cycle_id,
        competence, base_amount, net_amount, invoice_limit_amount, invoice_limit_source, invoice_expected_amount,
        complement_amount, complement_method, calc_version, created_by, invoice_review_status)
      VALUES ($1, $2, $3, $4, $5, $6, 6000, 6000, 6000, 'workspace', 6000, 0, 'caju_saldo_livre', 'ensaio', $7, 'awaiting_issue')`,
    [closingId, workspaceId, companyId, providerId, cycleId, competence, userId]);
  });
}

async function limpar() {
  // A cascata do grupo leva junto notas, histórico, fechamentos e cadastros.
  await comTenant(async (client) => {
    await client.query("DELETE FROM fdp_workspaces WHERE id = $1", [workspaceId]);
    await client.query("DELETE FROM fdp_users WHERE id = $1", [userId]);
  }).catch(() => undefined);
  await pool.end().catch(() => undefined);
}

const fechamento = {
  id: closingId, company_id: companyId, provider_id: providerId,
  payroll_cycle_id: cycleId, competence, invoice_expected_amount: 6000,
};

async function main() {
  await semear();
  const policy = await loadInvoicePolicy(d1, workspaceId);
  conferir("a política padrão do grupo exige nota aprovada", policy.reviewPolicy === "required", policy.reviewPolicy);

  // 1. Antes de qualquer nota, o pagamento está bloqueado e a lista já mostra
  //    quem precisa emitir — sem cadastro manual nenhum (§11).
  let linhas = await listInvoicePanel(d1, { workspaceId, companyId, cycleId, policy });
  conferir("a lista nasce dos pagamentos da competência", linhas.length === 1, `linhas=${linhas.length}`);
  conferir("quem não enviou aparece como aguardando nota",
    linhas[0]?.reviewStatus === "awaiting_issue", linhas[0]?.reviewStatus);
  conferir("o pagamento nasce bloqueado, com o motivo por extenso",
    linhas[0]?.paymentBlock.includes("não foi enviada"), linhas[0]?.paymentBlock);

  // 2. A primeira nota chega com valor a menor: R$ 5.500,00 (§32, prestador 03).
  const primeira = await registerInvoice(d1, {
    workspaceId, closing: fechamento,
    invoiceNumber: "1245", series: "1", issueDate: `${competence}-05`,
    issuerDocument: "26.016.500/0001-05", issuerName: "Empresa XPTO LTDA",
    receiverDocument: "11222333000181", serviceDescription: "Serviço prestado",
    amount: 5500, notes: "", documentId: null, duplicateAck: false, replacesInvoiceId: null,
    actorUserId: userId, actorName: "Conferente", ip: "203.0.113.7", userAgent: "ensaio",
  });
  conferir("a divergência é calculada no registro", primeira.comparison.difference === -500,
    String(primeira.comparison.difference));

  linhas = await listInvoicePanel(d1, { workspaceId, companyId, cycleId, policy });
  conferir("o pagamento passa a mostrar a nota anexada", linhas[0]?.reviewStatus === "received", linhas[0]?.reviewStatus);
  conferir("e continua bloqueado enquanto ninguém conferir",
    linhas[0]?.paymentBlock.length > 0, linhas[0]?.paymentBlock);
  conferir("a diferença aparece na linha", linhas[0]?.differenceAmount === -500, String(linhas[0]?.differenceAmount));

  // 3. Conferência recusa a nota com motivo.
  const recebida = await findInvoice(d1, workspaceId, primeira.invoiceId);
  await reviewInvoice(d1, {
    workspaceId, invoice: recebida,
    closing: { id: closingId, status: "review", invoice_expected_amount: 6000 },
    action: "reject", checklist: { amount: false }, requiredChecks: [],
    reviewNote: "", rejection: { reason: "amount_mismatch", detail: "" },
    actorUserId: userId, actorName: "Conferente",
  });
  linhas = await listInvoicePanel(d1, { workspaceId, companyId, cycleId, policy });
  conferir("a recusa aparece no pagamento", linhas[0]?.reviewStatus === "rejected", linhas[0]?.reviewStatus);

  // 4. O prestador reenvia corrigida: a anterior é preservada (§15, §30).
  const substituta = await registerInvoice(d1, {
    workspaceId, closing: fechamento,
    invoiceNumber: "1258", series: "1", issueDate: `${competence}-09`,
    issuerDocument: "26016500000105", issuerName: "Empresa XPTO LTDA",
    receiverDocument: "11222333000181", serviceDescription: "Serviço prestado",
    amount: 6000, notes: "", documentId: null, duplicateAck: false,
    replacesInvoiceId: primeira.invoiceId,
    actorUserId: userId, actorName: "Conferente", ip: "203.0.113.7", userAgent: "ensaio",
  });
  conferir("a substituta é o segundo envio do pagamento", substituta.attempt === 2, String(substituta.attempt));
  conferir("a substituição aponta para a nota anterior",
    substituta.replacedInvoiceId === primeira.invoiceId, String(substituta.replacedInvoiceId));

  const versoes = await listClosingInvoices(d1, workspaceId, closingId);
  conferir("as duas versões continuam no banco", versoes.length === 2, `versões=${versoes.length}`);
  const anterior = await findInvoice(d1, workspaceId, primeira.invoiceId);
  conferir("a nota rejeitada mantém o motivo depois de substituída",
    anterior.rejection_reason === "amount_mismatch", anterior.rejection_reason);
  conferir("a nota anterior sai de cena sem ser apagada",
    Boolean(anterior.superseded_at) && anterior.replaced_by_invoice_id === substituta.invoiceId);

  // 5. Aprovação libera o pagamento (§31).
  const atual = await findInvoice(d1, workspaceId, substituta.invoiceId);
  const decisao = await reviewInvoice(d1, {
    workspaceId, invoice: atual,
    closing: { id: closingId, status: "review", invoice_expected_amount: 6000 },
    action: "approve", checklist: { amount: true, competence: true }, requiredChecks: ["amount"],
    reviewNote: "Conferida com o contrato", rejection: { reason: "", detail: "" },
    actorUserId: userId, actorName: "Conferente",
  });
  conferir("a aprovação registra a decisão", decisao.status === "approved", decisao.status);

  linhas = await listInvoicePanel(d1, { workspaceId, companyId, cycleId, policy });
  conferir("o pagamento fica liberado", linhas[0]?.paymentBlock === "", linhas[0]?.paymentBlock);
  conferir("o valor confere", linhas[0]?.differenceAmount === 0, String(linhas[0]?.differenceAmount));
  conferir("o responsável pela conferência é gravado",
    linhas[0]?.reviewedByUserId === userId, linhas[0]?.reviewedByUserId);

  // 6. As recusas que precisam existir, e a que não pode existir.
  //
  //    Rejeitar uma nota já aprovada é caminho legítimo e é justamente o que o
  //    §30 pede no lugar de apagar: a correção passa por rejeitar/substituir,
  //    com histórico. O que não pode é decidir sobre uma versão que já saiu de
  //    cena, aprovar sem o checklist que o grupo tornou obrigatório, ou mexer
  //    na nota de um pagamento concluído.
  const recusa = async (nome, entrada) => {
    try {
      await reviewInvoice(d1, entrada);
      conferir(nome, false, "a operação foi aceita");
    } catch (erro) {
      conferir(nome, true, erro instanceof Error ? erro.message.slice(0, 60) : "");
    }
  };

  await recusa("uma versão substituída não volta a ser conferida", {
    workspaceId, invoice: await findInvoice(d1, workspaceId, primeira.invoiceId),
    closing: { id: closingId, status: "review", invoice_expected_amount: 6000 },
    action: "approve", checklist: {}, requiredChecks: [],
    reviewNote: "", rejection: { reason: "", detail: "" },
    actorUserId: userId, actorName: "Conferente",
  });

  await recusa("aprovar sem o checklist obrigatório é recusado", {
    workspaceId, invoice: await findInvoice(d1, workspaceId, substituta.invoiceId),
    closing: { id: closingId, status: "review", invoice_expected_amount: 6000 },
    action: "approve", checklist: { amount: true }, requiredChecks: ["amount", "competence"],
    reviewNote: "", rejection: { reason: "", detail: "" },
    actorUserId: userId, actorName: "Conferente",
  });

  await recusa("nota de pagamento concluído não é alterada", {
    workspaceId, invoice: await findInvoice(d1, workspaceId, substituta.invoiceId),
    closing: { id: closingId, status: "paid", invoice_expected_amount: 6000 },
    action: "reject", checklist: {}, requiredChecks: [],
    reviewNote: "", rejection: { reason: "canceled_invoice", detail: "" },
    actorUserId: userId, actorName: "Conferente",
  });

  // A correção prevista no §30: rejeitar a nota aprovada volta a travar o
  // pagamento, em vez de apagar o documento.
  await reviewInvoice(d1, {
    workspaceId, invoice: await findInvoice(d1, workspaceId, substituta.invoiceId),
    closing: { id: closingId, status: "review", invoice_expected_amount: 6000 },
    action: "reject", checklist: {}, requiredChecks: [],
    reviewNote: "", rejection: { reason: "canceled_invoice", detail: "" },
    actorUserId: userId, actorName: "Conferente",
  });
  linhas = await listInvoicePanel(d1, { workspaceId, companyId, cycleId, policy });
  conferir("rejeitar a nota aprovada volta a bloquear o pagamento",
    linhas[0]?.paymentBlock.length > 0, linhas[0]?.paymentBlock);

  // E aprová-la de novo devolve o pagamento ao estado apto, com o histórico
  // guardando as duas decisões.
  await reviewInvoice(d1, {
    workspaceId, invoice: await findInvoice(d1, workspaceId, substituta.invoiceId),
    closing: { id: closingId, status: "review", invoice_expected_amount: 6000 },
    action: "approve", checklist: { amount: true }, requiredChecks: ["amount"],
    reviewNote: "Cancelamento revertido pelo prestador", rejection: { reason: "", detail: "" },
    actorUserId: userId, actorName: "Conferente",
  });
  linhas = await listInvoicePanel(d1, { workspaceId, companyId, cycleId, policy });
  conferir("e a nova aprovação libera o pagamento outra vez", linhas[0]?.paymentBlock === "");

  // 7. Indicadores e histórico.
  const resumo = summarizeInvoiceCompetence(linhas, policy.reviewPolicy);
  conferir("o progresso da competência é 100% com a única nota aprovada",
    resumo.progress === 100 && resumo.approvedCount === 1, `progresso=${resumo.progress}`);
  conferir("o valor coberto por nota aprovada bate com o esperado",
    resumo.approvedAmount === 6000, String(resumo.approvedAmount));

  const historico = await listInvoiceEvents(d1, workspaceId, closingId);
  const acoes = historico.map((linha) => String(linha.action));
  for (const acao of ["uploaded", "rejected", "replaced", "approved"]) {
    conferir(`o histórico registra "${acao}"`, acoes.includes(acao), acoes.join(", "));
  }
  conferir("o histórico é escrito em português",
    historico.some((linha) => String(linha.summary).includes("NF 1258 aprovada")),
    String(historico[0]?.summary ?? ""));

  // 8. A regra de liberação vale igual fora da listagem.
  conferir("a mesma regra libera o pagamento em qualquer chamador",
    invoicePaymentBlock({ expectedAmount: 6000, reviewStatus: "approved", policy: policy.reviewPolicy }) === "");
}

try {
  await main();
} finally {
  await limpar();
}

if (falhas.length > 0) {
  console.error(`\nENSAIO DE NOTA FISCAL REPROVADO: ${falhas.length} verificação(ões).`);
  process.exit(1);
}
console.log("\nEnsaio de nota fiscal aprovado: registro, substituição, conferência, bloqueio e histórico verificados contra o banco.");
