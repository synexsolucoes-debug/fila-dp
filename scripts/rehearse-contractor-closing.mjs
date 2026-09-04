/**
 * Ensaio da apuração PJ contra um PostgreSQL real.
 *
 * Existe por causa de um defeito que passou por toda a suíte e caiu em
 * produção: **reapurar quebrava sempre que a nota esperada tinha centavos**.
 *
 * A instrução de apuração decide a situação da nota com uma comparação —
 * `CASE WHEN ? <= 0 THEN 'not_required'` —, e o PostgreSQL infere o tipo do
 * parâmetro pelo outro lado, o literal `0`, que é `integer`. Como o driver
 * manda parâmetro como texto, uma nota de 5.102,46 chega como "5102.46" e o
 * banco recusa a instrução inteira com `invalid input syntax for type
 * integer`. Um valor redondo passava, porque 6000,00 vira "6000". Daí o
 * defeito parecer aleatório: quebrava nos prestadores cujo valor tinha
 * centavos — e derrubava com eles a apuração da competência inteira.
 *
 * Nenhum teste de unidade alcança isso: o erro é do banco inferindo tipo, e só
 * aparece quando a instrução de verdade encontra um PostgreSQL de verdade.
 * Por isso o ensaio chama `upsertContractorClosing` importada — não uma cópia
 * da consulta — e confere os centavos nos dois caminhos que a função tem:
 * criar o fechamento e reapurar o que já existe.
 *
 * Uso:
 *   DATABASE_URL="postgres://…" FDP_DB_DRIVER=pg node scripts/rehearse-contractor-closing.mjs
 *
 * O banco precisa ter as migrations aplicadas. Tudo o que o ensaio escreve
 * fica dentro de um grupo próprio, apagado por ele no fim.
 */
import { randomUUID } from "node:crypto";

const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!databaseUrl?.startsWith("postgres")) {
  throw new Error("Defina DATABASE_URL com uma conexão PostgreSQL antes de rodar o ensaio.");
}
// O adaptador da aplicação, com o driver local: é o mesmo caminho de parâmetro
// que a rota usa, e é justamente o caminho que produz o defeito.
process.env.FDP_DB_DRIVER ??= "pg";

const { getScopedD1 } = await import("../db/index.ts");
const { upsertContractorClosing } = await import("../lib/payment-service.ts");
const { readFixedItemEdit } = await import("../lib/contractor-input.ts");
const { fromCents } = await import("../lib/payments.ts");

const workspaceId = `ws-apuracao-${randomUUID().slice(0, 8)}`;
const competence = "2099-03";
const companyId = `${workspaceId}-co`;
const cycleId = `${workspaceId}-cy`;
const providerId = `${workspaceId}-pj`;
const ownerId = `${workspaceId}-user`;
const itemDeterminadoId = `${workspaceId}-fixo`;

const d1 = getScopedD1({ workspaceId, userId: ownerId });
const falhas = [];

/* O caso do defeito, em números: 6.000,00 de base com um desconto de 59,93
   deixa 5.940,07 de líquido.
   O parâmetro que quebrava é o da NOTA esperada, e é por isso que este
   prestador não tem teto: sem teto a nota é o próprio líquido, e chega ao
   banco com centavos. Com teto de 3.000,00 o defeito se esconde — a nota fica
   redonda, "3000" atravessa como inteiro válido e a instrução passa. */
const baseAmount = 6000;
const descontoComCentavos = 59.93;

/* E, na mesma folha, um lançamento recorrente "determinado" já encerrado com
   competência final no futuro. Encerrar grava a data e marca o item como
   `ended` no mesmo instante; enquanto o marcador decidia, o lançamento sumia
   da folha antes da data que ele mesmo definiu — sem erro nenhum aparecer,
   que é o pior jeito de um valor desaparecer. */
const descontoDeterminado = 100;
const liquidoEsperado = 5840.07;

async function semear() {
  await d1.prepare("INSERT INTO fdp_users (id, email, name) VALUES (?, ?, 'Dono do ensaio')")
    .bind(ownerId, `${workspaceId}@ensaio.test`).run();
  await d1.prepare("INSERT INTO fdp_workspaces (id, name, slug, owner_user_id, status) VALUES (?, 'Ensaio da apuração', ?, ?, 'active')")
    .bind(workspaceId, workspaceId, ownerId).run();
  await d1.prepare(`INSERT INTO fdp_companies (id, workspace_id, legal_name, trade_name, tax_id, status)
    VALUES (?, ?, 'Ensaio LTDA', 'Ensaio', '99888777000166', 'active')`).bind(companyId, workspaceId).run();
  await d1.prepare(`INSERT INTO fdp_payroll_cycles (id, workspace_id, company_id, competence, status, created_by)
    VALUES (?, ?, ?, ?, 'processing', ?)`).bind(cycleId, workspaceId, companyId, competence, ownerId).run();
  await d1.prepare(`INSERT INTO fdp_auxiliary_providers (id, workspace_id, provider_type, code, legal_name, trade_name, tax_id, status)
    VALUES (?, ?, 'contractor', 'PJ001', 'Prestador do Ensaio LTDA', 'Ensaio', '11222333000181', 'active')`)
    .bind(providerId, workspaceId).run();
  await d1.prepare(`INSERT INTO fdp_contractor_profiles
      (provider_id, workspace_id, company_id, contract_reference, role_title, base_amount, invoice_limit_override, complement_method, status, updated_by)
    VALUES (?, ?, ?, 'CT-ENSAIO-1', 'Analista', ?, NULL, 'caju_saldo_livre', 'active', 'ensaio')`)
    .bind(providerId, workspaceId, companyId, baseAmount).run();
  await d1.prepare(`INSERT INTO fdp_contractor_components
      (id, workspace_id, company_id, provider_id, payroll_cycle_id, competence,
       direction, component_type, description, component_quantity, amount, origin, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 'debit', 'other_debit', 'Desconto com centavos', 1, ?, 'manual', 'active', 'ensaio')`)
    .bind(randomUUID(), workspaceId, companyId, providerId, cycleId, competence, descontoComCentavos).run();
  await d1.prepare(`INSERT INTO fdp_contractor_fixed_items
      (id, workspace_id, company_id, provider_id, direction, component_type, description, amount,
       effective_from, effective_to, status, note, created_by)
    VALUES (?, ?, ?, ?, 'debit', 'other_debit', 'Determinado encerrado com data futura', ?, ?, ?, 'ended', '', 'ensaio')`)
    .bind(itemDeterminadoId, workspaceId, companyId, providerId, descontoDeterminado, "2099-01", "2099-06").run();
}

const profile = () => d1.prepare(`SELECT p.provider_id, p.company_id, p.contract_reference, p.base_amount, p.fixed_caju_difference,
    p.invoice_limit_override, p.complement_method, p.status, p.contract_type, p.contract_start, p.contract_end, p.contract_total_amount,
    a.legal_name, a.trade_name
  FROM fdp_contractor_profiles p JOIN fdp_auxiliary_providers a ON a.workspace_id = p.workspace_id AND a.id = p.provider_id
  WHERE p.workspace_id = ? AND p.provider_id = ?`).bind(workspaceId, providerId).first();

/* Uma instrução por tabela, na ordem inversa das dependências.
   O laço sobre uma lista de nomes seria mais curto, mas interpolar o nome da
   tabela tira a consulta do alcance do `verify:sql` — e o verificador reprova
   quando a conta de consultas fora do alcance sobe. Um ensaio não deveria
   custar cobertura ao resto do produto. */
async function limpar() {
  const escrito = [
    d1.prepare("DELETE FROM fdp_contractor_components WHERE workspace_id = ?").bind(workspaceId),
    d1.prepare("DELETE FROM fdp_contractor_fixed_items WHERE workspace_id = ?").bind(workspaceId),
    d1.prepare("DELETE FROM fdp_contractor_closings WHERE workspace_id = ?").bind(workspaceId),
    d1.prepare("DELETE FROM fdp_contractor_profiles WHERE workspace_id = ?").bind(workspaceId),
    d1.prepare("DELETE FROM fdp_auxiliary_providers WHERE workspace_id = ?").bind(workspaceId),
    d1.prepare("DELETE FROM fdp_payroll_cycles WHERE workspace_id = ?").bind(workspaceId),
    d1.prepare("DELETE FROM fdp_companies WHERE workspace_id = ?").bind(workspaceId),
    d1.prepare("DELETE FROM fdp_workspaces WHERE id = ?").bind(workspaceId),
    d1.prepare("DELETE FROM fdp_users WHERE id = ?").bind(ownerId),
  ];
  for (const instrucao of escrito) await instrucao.run().catch(() => undefined);
}

async function main() {
  await semear();
  const cycle = { id: cycleId, company_id: companyId, competence, status: "processing" };
  const entrada = { workspaceId, profile: await profile(), cycle, userId: ownerId };

  /* 1. Criar o fechamento. Antes da correção, esta chamada já morria aqui com
        `invalid input syntax for type integer: "5940.07"` — e com ela a
        apuração da competência inteira, porque a rota percorre os prestadores
        em sequência. */
  const criado = await upsertContractorClosing(d1, entrada);
  if (Math.abs(criado.calculation.netAmount - liquidoEsperado) > 0.005) {
    falhas.push(`líquido apurado ${criado.calculation.netAmount} — esperado ${liquidoEsperado}`);
  }

  /* 2. Reapurar o mesmo fechamento. É o caminho do UPDATE, onde mora a
        comparação que inferia inteiro — o INSERT do primeiro passo não passa
        por ela, então só este segundo passo prova a correção. */
  const reapurado = await upsertContractorClosing(d1, { ...entrada, profile: await profile() });
  if (reapurado.created) falhas.push("a reapuração criou um segundo fechamento em vez de atualizar o existente");
  if (Math.abs(reapurado.calculation.netAmount - liquidoEsperado) > 0.005) {
    falhas.push(`líquido reapurado ${reapurado.calculation.netAmount} — esperado ${liquidoEsperado}`);
  }

  /* 3. E o que ficou gravado tem os centavos onde o defeito estava: na nota
        esperada. Sem teto configurado, a nota é o líquido inteiro e não sobra
        complemento. */
  const gravado = await d1.prepare(`SELECT net_amount, invoice_expected_amount, complement_amount, invoice_review_status
    FROM fdp_contractor_closings WHERE workspace_id = ? AND id = ?`).bind(workspaceId, reapurado.closingId).first();
  const nota = Number(gravado.invoice_expected_amount);
  const complemento = Number(gravado.complement_amount);
  if (Math.abs(Number(gravado.net_amount) - liquidoEsperado) > 0.005) {
    falhas.push(`o líquido gravado é ${gravado.net_amount} — esperado ${liquidoEsperado}`);
  }
  if (Math.abs(nota + complemento - liquidoEsperado) > 0.005) {
    falhas.push(`nota ${nota.toFixed(2)} + complemento ${complemento.toFixed(2)} não somam o líquido ${liquidoEsperado.toFixed(2)}`);
  }
  if (Math.abs(nota - liquidoEsperado) > 0.005) {
    falhas.push(`sem teto, a nota deveria ser o líquido ${liquidoEsperado.toFixed(2)} e veio ${nota.toFixed(2)}`);
  }
  // A comparação que quebrava também precisa continuar decidindo certo: com
  // nota a emitir, a conferência fica aguardando — não "não exigida".
  if (gravado.invoice_review_status !== "awaiting_issue") {
    falhas.push(`situação da conferência ${gravado.invoice_review_status} — esperado awaiting_issue com nota a emitir`);
  }

  /* 4. E o lançamento determinado está na folha, materializado como componente
        da competência — não só somado por fora. É pela linha que a conferência
        explica o valor. */
  const materializado = await d1.prepare(`SELECT amount, status FROM fdp_contractor_components
    WHERE workspace_id = ? AND payroll_cycle_id = ? AND fixed_item_id = ?`)
    .bind(workspaceId, cycleId, itemDeterminadoId).first();
  if (!materializado) {
    falhas.push("o lançamento determinado não entrou na folha, mesmo com a competência final ainda à frente");
  } else if (materializado.status !== "active") {
    falhas.push(`o lançamento determinado entrou como ${materializado.status} em vez de ativo`);
  } else if (Math.abs(Number(materializado.amount) - descontoDeterminado) > 0.005) {
    falhas.push(`o lançamento determinado entrou por ${materializado.amount} em vez de ${descontoDeterminado}`);
  }

  /* 5. Corrigir o valor do recorrente chega na folha.
        Editar não existia: o componente da competência recusava a mudança
        mandando "altere o lançamento fixo de origem", e a origem só sabia
        nascer e morrer. Quem precisava aplicar um reajuste tinha de encerrar o
        item e cadastrar outro — duas linhas no lugar de uma. O ensaio usa a
        mesma leitura de entrada da rota, e reapura como ela reapura. */
  const edicao = readFixedItemEdit({ amount: "150,00", description: "Determinado reajustado" });
  await d1.prepare(`UPDATE fdp_contractor_fixed_items SET
      amount = COALESCE(?::numeric, amount),
      description = COALESCE(?, description),
      updated_at = now()
    WHERE workspace_id = ? AND id = ?`)
    .bind(fromCents(edicao.amountCents), edicao.description, workspaceId, itemDeterminadoId).run();
  const depois = await upsertContractorClosing(d1, { ...entrada, profile: await profile() });
  const esperadoDepois = baseAmount - descontoComCentavos - 150;
  if (Math.abs(depois.calculation.netAmount - esperadoDepois) > 0.005) {
    falhas.push(`após corrigir o recorrente para 150,00 o líquido é ${depois.calculation.netAmount} — esperado ${esperadoDepois.toFixed(2)}`);
  }
  const corrigido = await d1.prepare(`SELECT amount, description FROM fdp_contractor_components
    WHERE workspace_id = ? AND payroll_cycle_id = ? AND fixed_item_id = ?`)
    .bind(workspaceId, cycleId, itemDeterminadoId).first();
  if (!corrigido || Math.abs(Number(corrigido.amount) - 150) > 0.005) {
    falhas.push(`a correção não chegou ao componente da competência: ${corrigido ? corrigido.amount : "linha ausente"}`);
  }
  if (corrigido && corrigido.description !== "Determinado reajustado") {
    falhas.push(`a descrição corrigida não chegou à folha: ${corrigido.description}`);
  }

  console.log(`apurado ${Number(gravado.net_amount).toFixed(2)}; nota ${nota.toFixed(2)} + complemento ${complemento.toFixed(2)}; conferência ${gravado.invoice_review_status}; determinado na folha: ${materializado ? "sim" : "não"}; após corrigir: ${depois.calculation.netAmount.toFixed(2)}`);
}

try {
  await main();
} finally {
  await limpar();
}

if (falhas.length) {
  console.error("\nFALHOU:");
  for (const falha of falhas) console.error(` - ${falha}`);
  process.exit(1);
}
console.log("OK: a apuração PJ atravessa valores com centavos ao criar e ao reapurar.");
