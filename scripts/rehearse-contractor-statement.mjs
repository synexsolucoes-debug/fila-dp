/**
 * Ensaio do extrato analítico PJ contra um PostgreSQL real.
 *
 * O extrato existe para conferência, e conferência tem uma única exigência
 * dura: **as linhas precisam somar o número do fechamento**. Se o extrato disser
 * 8.560,00 e a apuração disser 8.700,00, ele não é um documento de conferência
 * — é uma segunda versão da verdade, que é pior que não ter documento nenhum.
 *
 * Nenhum teste de unidade prova isso. A soma acontece em SQL, sobre uma união
 * de duas consultas, com valores em `numeric` e um lançamento cancelado que
 * precisa aparecer sem entrar na conta. Só um banco de verdade responde.
 *
 * A consulta vem de `lib/payment-reports.ts`, importada — não copiada. Um
 * ensaio que reescreve a consulta prova a cópia e deixa o produto sem prova.
 *
 * Uso:
 *   DATABASE_URL="postgres://…" node scripts/rehearse-contractor-statement.mjs
 *
 * O banco precisa ter as migrations aplicadas. Tudo o que o ensaio escreve fica
 * dentro de um grupo próprio, criado e apagado por ele.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { reports } from "../lib/payment-reports.ts";

const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!databaseUrl?.startsWith("postgres")) {
  throw new Error("Defina DATABASE_URL com uma conexão PostgreSQL antes de rodar o ensaio.");
}

const workspaceId = `ws-ensaio-${randomUUID().slice(0, 8)}`;
const competence = "2099-01";
const companyId = `${workspaceId}-co`;
const cycleId = `${workspaceId}-cy`;

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const falhas = [];

/** Converte os `?` do adaptador para os `$n` do driver PostgreSQL. */
function toPositional(sql) {
  let index = 0;
  return sql.replace(/\?/gu, () => `$${++index}`);
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // A política de RLS lê esta variável; sem ela o ensaio não enxerga o que
    // acabou de escrever, e o resultado vazio pareceria aprovação.
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);

    /* Tudo o que o ensaio precisa é criado por ele: um banco recém-migrado não
       tem usuário nem grupo, e depender da semente de outro passo faria este
       ensaio passar ou falhar pela ordem em que a CI roda as etapas. */
    const ownerId = `${workspaceId}-user`;
    await client.query(
      `INSERT INTO fdp_users (id, email, name) VALUES ($1, $2, 'Dono do ensaio')`,
      [ownerId, `${workspaceId}@ensaio.test`],
    );
    await client.query(
      `INSERT INTO fdp_workspaces (id, name, slug, owner_user_id, status) VALUES ($1, 'Ensaio do extrato', $2, $3, 'active')`,
      [workspaceId, workspaceId, ownerId],
    );
    await client.query(
      `INSERT INTO fdp_companies (id, workspace_id, legal_name, trade_name, tax_id, status)
       VALUES ($1, $2, 'Ensaio LTDA', 'Ensaio', '99888777000166', 'active')`,
      [companyId, workspaceId],
    );
    await client.query(
      `INSERT INTO fdp_payroll_cycles (id, workspace_id, company_id, competence, status, created_by)
       VALUES ($1, $2, $3, $4, 'processing', $5)`,
      [cycleId, workspaceId, companyId, competence, ownerId],
    );

    /* Um prestador com o caso que interessa: base contratual, dois proventos,
       dois descontos e um lançamento cancelado. O cancelado é o ponto — ele
       precisa aparecer no extrato e ficar fora da soma. */
    const providerId = `${workspaceId}-pj`;
    await client.query(
      `INSERT INTO fdp_auxiliary_providers (id, workspace_id, provider_type, code, legal_name, trade_name, tax_id, status)
       VALUES ($1, $2, 'contractor', 'PJ001', 'Prestador do Ensaio LTDA', 'Ensaio', '11222333000181', 'active')`,
      [providerId, workspaceId],
    );
    await client.query(
      `INSERT INTO fdp_contractor_profiles (provider_id, workspace_id, company_id, contract_reference, role_title, base_amount, complement_method, status, updated_by)
       VALUES ($1, $2, $3, 'CT-ENSAIO-1', 'Analista', 8000.00, 'caju_saldo_livre', 'active', 'ensaio')`,
      [providerId, workspaceId, companyId],
    );

    const base = 8000, creditos = 1200, descontos = 640;
    const liquido = base + creditos - descontos;
    const closingId = `${workspaceId}-cl`;
    await client.query(
      `INSERT INTO fdp_contractor_closings
        (id, workspace_id, company_id, provider_id, payroll_cycle_id, competence,
         base_amount, credits_amount, debits_amount, net_amount,
         invoice_limit_amount, invoice_limit_source, invoice_expected_amount,
         complement_amount, complement_method, caju_amount, status,
         invoice_status, caju_status, reconciliation_status, reconciliation_difference, calc_version, created_by)
       VALUES ($1,$2,$3,$4,$5,$6, $7,$8,$9,$10, 6000.00,'contract',6000.00, $11,'caju_saldo_livre',$11,'review',
         'pending','pending','pending',0,'v1','ensaio')`,
      [closingId, workspaceId, companyId, providerId, cycleId, competence, base, creditos, descontos, liquido, liquido - 6000],
    );

    const lancamentos = [
      ["credit", "commission", "Comissão do trimestre", 900, "active"],
      ["credit", "reimbursement", "Reembolso de deslocamento", 300, "active"],
      ["debit", "health_plan", "Plano de saúde", 480, "active"],
      ["debit", "equipment", "Notebook — 4a parcela", 160, "active"],
      ["debit", "absence", "Falta não justificada", 300, "canceled"],
    ];
    for (const [direction, type, description, amount, status] of lancamentos) {
      await client.query(
        `INSERT INTO fdp_contractor_components
          (id, workspace_id, company_id, provider_id, payroll_cycle_id, closing_id, competence,
           direction, component_type, description, component_quantity, amount, origin, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,'manual',$12,'ensaio')`,
        [randomUUID(), workspaceId, companyId, providerId, cycleId, closingId, competence,
          direction, type, description, amount, status],
      );
    }

    /* A consulta do produto, não uma reescrita dela. */
    const report = reports["contractor-analytical"];
    const pares = "paramPairs" in report ? report.paramPairs : 1;
    const values = Array.from({ length: pares }, () => [workspaceId, competence]).flat();
    const sql = `${report.query} ${report.order}`;
    const { rows } = await client.query(toPositional(sql), values);

    // 1. Toda rubrica aparece, inclusive a cancelada.
    const esperado = lancamentos.length + 1; // os lançamentos mais o valor contratual
    if (rows.length !== esperado) {
      falhas.push(`o extrato trouxe ${rows.length} linha(s); esperado ${esperado} (uma por rubrica, mais o valor contratual)`);
    }
    if (!rows.some((row) => row.rubrica === "Valor contratual")) {
      falhas.push("o valor contratual não aparece como linha — quem confere soma a coluna e o total não fecha");
    }
    if (!rows.some((row) => row.situacao === "canceled")) {
      falhas.push("o lançamento cancelado sumiu — quem confere fica sem explicação para a diferença");
    }

    // 2. A soma das linhas vivas é exatamente o líquido do fechamento.
    const vivas = rows.filter((row) => row.situacao !== "canceled");
    const soma = (tipo) => vivas
      .filter((row) => row.tipo === tipo)
      .reduce((total, row) => total + Number(row.valor), 0);
    const somaDoExtrato = soma("PROVENTO") - soma("DESCONTO");
    if (Math.abs(somaDoExtrato - liquido) > 0.005) {
      falhas.push(`o extrato soma ${somaDoExtrato.toFixed(2)} e o fechamento diz ${liquido.toFixed(2)} — não é documento de conferência`);
    }

    // 3. Uma coluna, um vocabulário. "ativo" ao lado de "active" faria o filtro
    //    da planilha descartar metade das linhas sem avisar.
    const situacoes = new Set(rows.map((row) => String(row.situacao)));
    for (const situacao of situacoes) {
      if (!["active", "canceled"].includes(situacao)) {
        falhas.push(`situação fora do vocabulário do lançamento: ${situacao}`);
      }
    }

    // 4. Toda coluna declarada existe de fato na linha — uma coluna declarada e
    //    ausente vira campo vazio no CSV, sem erro nenhum.
    for (const coluna of report.columns) {
      if (!(coluna in rows[0])) falhas.push(`coluna declarada e ausente no resultado: ${coluna}`);
    }

    console.log(`${rows.length} linha(s) no extrato; soma ${somaDoExtrato.toFixed(2)}; líquido ${liquido.toFixed(2)}`);
  } finally {
    // O ensaio não deixa rastro, mesmo se falhar no meio.
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

try {
  await main();
} finally {
  await pool.end();
}

if (falhas.length) {
  console.error("\nFALHOU:");
  for (const falha of falhas) console.error(` - ${falha}`);
  process.exit(1);
}
console.log("OK: o extrato analítico fecha com a apuração.");
