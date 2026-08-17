import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { capabilities, hasCapability } from "../lib/authorization.ts";
import { capabilityCatalog } from "../lib/capability-catalog.ts";
import { moduleWriteCapabilities } from "../lib/modules.ts";
import {
  caExpiryTone, damageRouting, decidedValueFor, discountStatusFor, discountTitle, discountTotal,
  disposalTouchesStock, epiDamageDecisions, epiDiscountDecisions, epiReturnConditions, returnRouting,
} from "../lib/epi.ts";
import { buildEpiCompliance } from "../lib/epi-compliance.ts";

/**
 * Controle de EPI.
 *
 * O módulo tem duas promessas que não podem depender de disciplina de quem
 * escrever a próxima rota, e são elas que estes testes prendem:
 *
 *  1. **desconto nunca é aplicado automaticamente.** Extravio, não devolução e
 *     dano por uso inadequado abrem uma *análise* com demanda para o DP. Uma
 *     decisão aprovada gera só uma movimentação em rascunho na Central.
 *  2. **o destino do EPI é consequência da condição informada,** não uma caixa
 *     de seleção livre. "Extraviado" com "volta ao estoque" marcado faria o
 *     estoque contar equipamento que ninguém tem.
 *
 * O resto verifica o que o §14 lista como critério de aceite: migration com
 * RLS, permissões aplicadas, telas com estado, e `workspaceId` em toda consulta.
 */

const migration = await readFile(new URL("../drizzle/postgres/0044_epi_control.sql", import.meta.url), "utf8");
const evolutionMigration = await readFile(new URL("../drizzle/postgres/0045_workspace_areas_shared_stock.sql", import.meta.url), "utf8");
const groupProductMigration = await readFile(new URL("../drizzle/postgres/0047_group_owned_epi_products.sql", import.meta.url), "utf8");
const complianceMigration = await readFile(new URL("../drizzle/postgres/0048_epi_compliance.sql", import.meta.url), "utf8");
const tabelas = [
  "fdp_epi_products", "fdp_epi_deliveries", "fdp_epi_returns", "fdp_epi_damages",
  "fdp_epi_disposals", "fdp_epi_discount_requests", "fdp_epi_movements", "fdp_epi_attachments",
];

/* -------------------------------------------------------------------------- */
/* Regras de destino                                                          */
/* -------------------------------------------------------------------------- */

test("a condição da devolução decide o destino, e nenhuma combinação é contraditória", () => {
  for (const condition of epiReturnConditions) {
    const routing = returnRouting(condition);
    // O que não voltou não pode ser reposto no estoque.
    if (condition === "not_returned" || condition === "lost") {
      assert.equal(routing.backToStock, false, `${condition} não pode voltar ao estoque`);
      assert.equal(routing.generateDpDemand, true, `${condition} precisa abrir análise para o DP`);
      assert.ok(routing.discountTrigger, `${condition} precisa nomear o gatilho`);
    }
    // Voltar ao estoque e ir para descarte ao mesmo tempo é o par impossível.
    assert.ok(!(routing.backToStock && routing.sendToDisposal), `${condition} repõe e descarta ao mesmo tempo`);
    // Quem vai para descarte precisa dizer por quê — a janela exige motivo.
    if (routing.sendToDisposal) assert.ok(routing.disposalReason, `${condition} vai ao descarte sem motivo`);
    // Só quem volta higienizado entra de novo no saldo.
    assert.equal(routing.backToStock, condition === "returned_sanitized");
  }
});

test("devolução higienizada repõe o estoque; pendente vai para higienização", () => {
  assert.deepEqual(returnRouting("returned_sanitized"), {
    backToStock: true, needsSanitizing: false, sendToDisposal: false, generateDpDemand: false,
    productStatus: "in_stock", disposalReason: null, discountTrigger: null,
  });
  const pendente = returnRouting("returned_pending_sanitizing");
  assert.equal(pendente.productStatus, "sanitizing");
  assert.equal(pendente.backToStock, false);
});

test("só a decisão de análise abre demanda na troca por danificação", () => {
  const comDemanda = epiDamageDecisions.filter((decision) => damageRouting(decision).discountTrigger);
  assert.deepEqual(comDemanda, ["send_to_discount_analysis"]);
  assert.equal(damageRouting("send_to_discount_analysis").discountTrigger, "misuse_damage");
  // Recusar a troca decide sobre o equipamento, não sobre o salário.
  assert.equal(damageRouting("refuse_exchange").discountTrigger, null);
});

test("troca sem desconto dá baixa no antigo e entrega o novo", () => {
  const routing = damageRouting("exchange_without_discount");
  assert.equal(routing.settleOldDelivery, true);
  assert.equal(routing.createDisposal, true);
  assert.equal(routing.deliverReplacement, true);
  assert.equal(routing.disposalReason, "damage");
  // Higienização não descarta nem entrega substituto.
  const higiene = damageRouting("send_to_sanitizing");
  assert.equal(higiene.productStatus, "sanitizing");
  assert.equal(higiene.createDisposal, false);
});

test("o descarte só debita estoque quando o EPI ainda estava no estoque", () => {
  // O que veio de devolução ou de troca já saiu do saldo na entrega; debitar de
  // novo tiraria duas unidades por uma.
  assert.equal(disposalTouchesStock("manual"), true);
  assert.equal(disposalTouchesStock("return"), false);
  assert.equal(disposalTouchesStock("damage"), false);
});

/* -------------------------------------------------------------------------- */
/* Desconto: análise, nunca lançamento                                        */
/* -------------------------------------------------------------------------- */

test("o título da demanda segue o formato contratado", () => {
  assert.equal(discountTitle("Ana Souza"), "Analisar possível desconto de EPI — Ana Souza");
  // Nome vazio não pode virar um título truncado sem sujeito.
  assert.equal(discountTitle("   "), "Analisar possível desconto de EPI — colaborador não identificado");
});

test("nenhuma decisão produz valor maior que o EPI em análise", () => {
  const total = discountTotal(89.9, 2);
  assert.equal(total, 179.8);
  for (const decision of epiDiscountDecisions) {
    const valor = decidedValueFor(decision, 10_000, total);
    assert.ok(valor <= total, `${decision} decidiu acima do valor em análise`);
    assert.ok(valor >= 0);
  }
  assert.equal(decidedValueFor("full_discount", 0, total), total);
  assert.equal(decidedValueFor("partial_discount", 50, total), 50);
  // Parcial acima do total é limitado, não aceito.
  assert.equal(decidedValueFor("partial_discount", 999, total), total);
});

test("recusar e adiar não descontam nada", () => {
  for (const decision of ["no_discount", "request_more_info", "forward_to_payroll", "close_without_action"] as const) {
    assert.equal(decidedValueFor(decision, 500, 500), 0, `${decision} não pode carregar valor`);
  }
  assert.equal(discountStatusFor("no_discount"), "refused");
  assert.equal(discountStatusFor("request_more_info"), "awaiting_dp_analysis");
  assert.equal(discountStatusFor("forward_to_payroll"), "awaiting_approval");
  assert.equal(discountStatusFor("full_discount"), "approved_for_discount");
});

test("o banco recusa a decisão contraditória mesmo fora da rota", () => {
  // A rota impede; o CHECK garante. Sem ele, um caminho futuro poderia gravar
  // "aprovado para desconto" com valor zero, ou acima do valor do equipamento.
  assert.match(migration, /fdp_epi_discounts_approval_check[\s\S]{0,220}decided_value" > 0/u);
  assert.match(migration, /fdp_epi_discounts_decided_bound_check[\s\S]{0,220}"decided_value" <= "fdp_epi_discount_requests"\."total_value"/u);
});

test("o CA vencido e o que está por vencer são estados diferentes", () => {
  assert.equal(caExpiryTone("2026-01-01", "2026-06-01"), "expired");
  assert.equal(caExpiryTone("2026-07-01", "2026-06-01"), "expiring");
  assert.equal(caExpiryTone("2027-06-01", "2026-06-01"), "valid");
  // Sem validade cadastrada não há alarme falso.
  assert.equal(caExpiryTone(null, "2026-06-01"), "unknown");
});

test("o mapa de conformidade distingue falta, troca próxima e lotação sem regra", () => {
  const employees = [
    { id: "ana", companyId: "c1", name: "Ana", registrationNumber: "1", departmentId: "d1", departmentName: "Operação", positionId: "p1", positionName: "Operadora" },
    { id: "bruno", companyId: "c1", name: "Bruno", registrationNumber: "2", departmentId: "d1", departmentName: "Operação", positionId: "p1", positionName: "Operador" },
    { id: "carla", companyId: "c1", name: "Carla", registrationNumber: "3", departmentId: "d2", departmentName: "Administrativo", positionId: "p2", positionName: "Analista" },
  ];
  const requirements = [{
    id: "r1", companyId: "c1", departmentId: "d1", departmentName: "Operação", positionId: "", positionName: "",
    productId: "helmet", productName: "Capacete", caNumber: "123", caExpiresOn: "2027-01-01", productExpiresOn: "",
    quantity: 1, replacementDays: 180, warningDays: 30,
  }];
  const compliance = buildEpiCompliance(employees, requirements, [
    { employeeId: "ana", productId: "helmet", productName: "Capacete", quantity: 1, lastDeliveredOn: "2026-01-01" },
  ], "2026-06-01");
  assert.equal(compliance[0].status, "due_soon");
  assert.equal(compliance[0].nextExchangeOn, "2026-06-30");
  assert.equal(compliance[1].status, "missing");
  assert.equal(compliance[1].items[0].missingQuantity, 1);
  assert.equal(compliance[2].status, "unconfigured");
});

test("validade vencida prevalece sobre ciclo futuro quando o EPI está entregue", () => {
  const result = buildEpiCompliance([
    { id: "e1", companyId: "c1", name: "Ana", registrationNumber: "1", departmentId: "", departmentName: "", positionId: "", positionName: "" },
  ], [{
    id: "r1", companyId: "c1", departmentId: "", departmentName: "", positionId: "", positionName: "",
    productId: "p1", productName: "Luva", caNumber: "CA", caExpiresOn: "2026-05-31", productExpiresOn: "",
    quantity: 1, replacementDays: 365, warningDays: 30,
  }], [{ employeeId: "e1", productId: "p1", quantity: 1, lastDeliveredOn: "2026-05-01" }], "2026-06-01");
  assert.equal(result[0].status, "expired");
  assert.equal(result[0].items[0].expiryReason, "CA");
});

/* -------------------------------------------------------------------------- */
/* Multi-tenancy                                                              */
/* -------------------------------------------------------------------------- */

test("toda tabela do módulo tem RLS forçada e política por workspace", () => {
  for (const tabela of tabelas) {
    assert.match(migration, new RegExp(`ALTER TABLE "${tabela}" ENABLE ROW LEVEL SECURITY`, "u"), `${tabela} sem RLS`);
    assert.match(migration, new RegExp(`ALTER TABLE "${tabela}" FORCE ROW LEVEL SECURITY`, "u"), `${tabela} sem FORCE`);
    assert.match(migration, new RegExp(`ON "${tabela}"\\s*\\n\\s*USING \\("workspace_id" = NULLIF\\(current_setting\\('app\\.workspace_id', true\\), ''\\)\\)`, "u"),
      `${tabela} sem política de leitura por tenant`);
    assert.match(migration, new RegExp(`WITH CHECK \\("workspace_id" = NULLIF\\(current_setting\\('app\\.workspace_id', true\\), ''\\)\\);--> statement-breakpoint\\nALTER TABLE|WITH CHECK \\("workspace_id" = NULLIF\\(current_setting\\('app\\.workspace_id', true\\), ''\\)\\);`, "u"),
      `${tabela} sem política de escrita por tenant`);
  }
});

test("regras obrigatórias têm escopo tenant, lotação válida e não duplicam o mesmo EPI", () => {
  assert.match(complianceMigration, /CREATE TABLE "fdp_epi_requirements"/u);
  assert.match(complianceMigration, /fdp_epi_requirements_scope_product_uq[\s\S]{0,260}COALESCE\("department_id", ''\)[\s\S]{0,120}COALESCE\("position_id", ''\)/u);
  assert.match(complianceMigration, /fdp_epi_requirements_department_fk[\s\S]{0,300}"workspace_id", "company_id", "department_id"/u);
  assert.match(complianceMigration, /fdp_epi_requirements_position_fk[\s\S]{0,300}"workspace_id", "company_id", "position_id"/u);
  assert.match(complianceMigration, /ALTER TABLE "fdp_epi_requirements" FORCE ROW LEVEL SECURITY/u);
  assert.match(complianceMigration, /fdp_epi_requirements_workspace_isolation/u);
});

test("as referências entre tabelas carregam o workspace, então apontar para outro cliente não é representável", () => {
  // Chave composta em vez de FK só pelo id: o tenant faz parte da referência.
  assert.match(migration, /FOREIGN KEY \("workspace_id","company_id","product_id"\) REFERENCES "public"\."fdp_epi_products"\("workspace_id","company_id","id"\)/u);
  assert.match(migration, /FOREIGN KEY \("workspace_id","company_id","employee_id"\) REFERENCES "public"\."fdp_employees"\("workspace_id","company_id","id"\)/u);
  assert.match(migration, /FOREIGN KEY \("workspace_id","card_id"\) REFERENCES "public"\."fdp_cards"\("workspace_id","id"\)/u);
});

test("nenhuma consulta do módulo lê sem filtrar por workspace", async () => {
  const raiz = new URL("../app/api/epi/", import.meta.url);
  const arquivos: Array<[string, string]> = [];
  async function andar(dir: URL, prefixo: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await andar(new URL(`${entry.name}/`, dir), `${prefixo}${entry.name}/`);
      else if (entry.name.endsWith(".ts")) arquivos.push([`${prefixo}${entry.name}`, await readFile(new URL(entry.name, dir), "utf8")]);
    }
  }
  await andar(raiz, "");
  assert.ok(arquivos.length >= 10, `esperava as rotas do módulo, encontrei ${arquivos.length}`);

  const semTenant: string[] = [];
  for (const [caminho, fonte] of arquivos) {
    // Recorte montado em variável — `const conditions = ["workspace_id = ?"]`.
    // A lista **nasce** com o tenant, então toda condição acrescentada depois
    // se soma a ele em vez de substituí-lo. Aceitar a interpolação sem exigir
    // isto transformaria este teste em carimbo.
    const escopoAncorado = /(?:const|let)\s+\w+(?:\s*:\s*string\[\])?\s*=\s*\[\s*"(?:\w+\.)?workspace_id = \?"/u.test(fonte);
    for (const match of fonte.matchAll(/\.prepare\(\s*(`|")([\s\S]*?)\1/gu)) {
      const sql = match[2];
      if (!/\bfdp_epi_/u.test(sql)) continue;
      const resumo = `${caminho}: ${sql.replace(/\s+/gu, " ").slice(0, 90)}`;
      // Em `INSERT` o tenant não é filtro, é coluna gravada — e a política
      // `WITH CHECK` recusa a linha que trouxer outro workspace. O que se cobra
      // aqui é que a coluna esteja na lista, e não que exista um `WHERE`.
      if (/^\s*INSERT\s+INTO/iu.test(sql)) {
        if (!/\(\s*id\s*,\s*workspace_id\b/u.test(sql)) semTenant.push(resumo);
        continue;
      }
      if (/workspace_id\s*=/u.test(sql)) continue;
      // Sem `workspace_id` literal, só passa quem interpola um recorte que o
      // arquivo comprovadamente ancora no tenant.
      if (/\$\{/u.test(sql) && escopoAncorado) continue;
      semTenant.push(resumo);
    }
  }
  assert.deepEqual(semTenant, [], "consulta do Controle de EPI sem recorte de workspace");
});

test("toda rota do módulo passa por capability nomeada", async () => {
  const raiz = new URL("../app/api/epi/", import.meta.url);
  const rotas: Array<[string, string]> = [];
  async function andar(dir: URL, prefixo: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await andar(new URL(`${entry.name}/`, dir), `${prefixo}${entry.name}/`);
      else if (entry.name === "route.ts") rotas.push([`${prefixo}route.ts`, await readFile(new URL(entry.name, dir), "utf8")]);
    }
  }
  await andar(raiz, "");
  const semGuarda = rotas.filter(([, fonte]) => !/requireNamedCapability\(workspace, "epi\./u.test(fonte)).map(([caminho]) => caminho);
  assert.deepEqual(semGuarda, [], "rota de EPI sem verificação de permissão");

  // Escrita e leitura não podem cair na mesma permissão: quem só consulta não
  // entrega, não descarta e não decide desconto.
  const escrita = new Map([
    ["deliveries/route.ts", "epi.deliver"],
    ["returns/route.ts", "epi.return"],
    ["damages/route.ts", "epi.damage"],
    ["disposals/route.ts", "epi.dispose"],
    ["disposals/[id]/route.ts", "epi.dispose"],
    ["discounts/[id]/route.ts", "epi.discount.analyze"],
  ]);
  for (const [caminho, capability] of escrita) {
    const fonte = rotas.find(([nome]) => nome === caminho)?.[1];
    assert.ok(fonte, `rota ${caminho} não encontrada`);
    assert.match(fonte, new RegExp(`requireNamedCapability\\(workspace, "${capability.replace(/\./gu, "\\.")}"`, "u"),
      `${caminho} não exige ${capability}`);
  }
});

test("a exportação de relatório exige permissão própria e fica na auditoria", async () => {
  const rota = await readFile(new URL("../app/api/epi/reports/route.ts", import.meta.url), "utf8");
  assert.match(rota, /if \(format === "csv"\) requireNamedCapability\(workspace, "epi\.export"/u);
  assert.match(rota, /action: "epi_report\.exported"/u);
  // Campo livre que começa com `=` vira fórmula ao abrir a planilha.
  assert.match(rota, /\^\[=\+\\-@\\t\\r\]/u);
});

/* -------------------------------------------------------------------------- */
/* Permissões e catálogo                                                      */
/* -------------------------------------------------------------------------- */

test("as doze permissões do módulo existem, são descritas e têm dono", () => {
  const esperadas = [
    "epi.view", "epi.create", "epi.edit", "epi.delete", "epi.deliver", "epi.return",
    "epi.damage", "epi.dispose", "epi.discount.analyze", "epi.export", "epi.audit.view", "epi.stock.adjust",
  ] as const;
  for (const capability of esperadas) {
    assert.ok(capabilities.includes(capability), `${capability} fora do catálogo de permissões`);
    assert.equal(capabilityCatalog[capability].area, "epi", `${capability} sem área própria`);
    assert.ok(capabilityCatalog[capability].label.length > 10, `${capability} sem explicação para quem administra`);
  }
  // Negar o módulo precisa fechar as ações, não só a tela.
  for (const capability of esperadas.filter((item) => item !== "epi.view")) {
    assert.ok(moduleWriteCapabilities.epi.includes(capability), `${capability} não é governada pelo módulo`);
  }
});

test("apagar cadastro e ler a trilha ficam com o administrador", () => {
  assert.equal(hasCapability("member", "epi.delete"), false);
  assert.equal(hasCapability("member", "epi.audit.view"), false);
  assert.equal(hasCapability("admin", "epi.delete"), true);
  assert.equal(hasCapability("admin", "epi.audit.view"), true);
});

test("o membro opera o módulo; o observador só consulta; o convidado não entra", () => {
  for (const capability of ["epi.view", "epi.create", "epi.deliver", "epi.return", "epi.damage", "epi.dispose", "epi.discount.analyze", "epi.export"] as const) {
    assert.equal(hasCapability("member", capability), true, `membro precisa de ${capability}`);
  }
  assert.equal(hasCapability("observer", "epi.view"), true);
  for (const capability of ["epi.create", "epi.deliver", "epi.dispose", "epi.discount.analyze", "epi.export"] as const) {
    assert.equal(hasCapability("observer", capability), false, `observador não pode ${capability}`);
  }
  assert.equal(hasCapability("guest", "epi.view"), false);
});

test("o módulo entra no catálogo apontando para uma tela que existe", async () => {
  assert.match(migration, /INSERT INTO "fdp_modules"[\s\S]*?\('epi', 'Controle de EPI'/u);
  assert.match(migration, /'pessoas', 'epi', 'epi\.view'/u);
  // Sem a linha de plano o módulo existiria no catálogo e ficaria fora de todos
  // os contratos — visível na administração e inalcançável para o cliente.
  assert.match(migration, /INSERT INTO "fdp_plan_modules"[\s\S]*?SELECT p\."id", 'epi' FROM "fdp_saas_plans" p/u);

  const shell = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(shell, /epi: \{\s*\n\s*label: "Controle de EPI"/u);
  assert.match(shell, /module: "epi"/u);
  assert.match(shell, /view === "epi" && <EpiControlView/u);
});

/* -------------------------------------------------------------------------- */
/* Integração com o resto do produto                                          */
/* -------------------------------------------------------------------------- */

test("a demanda do DP nasce no mesmo lote da devolução que a motivou", async () => {
  const servico = await readFile(new URL("../lib/epi-service.ts", import.meta.url), "utf8");
  // Criar o cartão antes deixaria, em caso de falha do resto, uma demanda no
  // quadro sem caso por trás — alguém do DP analisando um desconto inexistente.
  assert.match(servico, /export async function prepareDiscountDemand/u);
  assert.doesNotMatch(servico, /INSERT INTO fdp_cards[\s\S]{0,600}\.run\(\)/u);
  assert.match(servico, /statements: \[demand\.statement, statement, movement\]/u);

  const devolucao = await readFile(new URL("../app/api/epi/returns/route.ts", import.meta.url), "utf8");
  assert.match(devolucao, /statements\.push\(\.\.\.analysis\.statements\)/u);
  assert.match(devolucao, /await d1\.batch\(statements\)/u);
});

test("o razão de movimentações é append-only e sustenta o histórico do colaborador", () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION "fdp_epi_movements_append_only"/u);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON "fdp_epi_movements"/u);
  assert.match(migration, /epi movements are append-only/u);
  assert.match(evolutionMigration, /DISABLE TRIGGER "fdp_epi_movements_append_only"[\s\S]{0,320}UPDATE "fdp_epi_movements"[\s\S]{0,320}ENABLE TRIGGER "fdp_epi_movements_append_only"/u);
});

test("descarte confirmado é imutável e não devolve o EPI ao estoque", () => {
  assert.match(migration, /CREATE TRIGGER "fdp_epi_disposals_guard"/u);
  assert.match(migration, /confirmed disposal is immutable/u);
  // Confirmar sem responsável e sem data é evidência que não prova nada.
  assert.match(migration, /fdp_epi_disposals_confirmation_check[\s\S]{0,260}"confirmed_by" IS NOT NULL AND "fdp_epi_disposals"\."confirmed_at" IS NOT NULL/u);
});

test("o estoque não fica negativo nem a devolução ultrapassa a entrega", () => {
  assert.match(migration, /fdp_epi_products_stock_check[\s\S]{0,120}"stock_quantity" >= 0/u);
  assert.match(migration, /fdp_epi_deliveries_settled_check[\s\S]{0,260}"settled_quantity" <= "fdp_epi_deliveries"\."quantity"/u);
});

test("o débito de estoque compartilhado é serializado e atômico com o evento", async () => {
  const servico = await readFile(new URL("../lib/epi-service.ts", import.meta.url), "utf8");
  // Conferir antes e gravar depois deixaria duas entregas simultâneas passarem
  // juntas pela última unidade.
  assert.match(evolutionMigration, /FROM fdp_epi_products[\s\S]{0,180}FOR UPDATE/u);
  assert.match(evolutionMigration, /UPDATE fdp_stock_balances[\s\S]{0,300}quantity \+ p_delta >= 0/u);
  assert.match(evolutionMigration, /EPI_INSUFFICIENT_STOCK/u);
  assert.match(servico, /SELECT fdp_apply_stock_change\(\?, \?, \?, \?, \?\)/u);

  const entrega = await readFile(new URL("../app/api/epi/deliveries/route.ts", import.meta.url), "utf8");
  // O débito, a entrega, o razão e a auditoria participam do mesmo lote.
  assert.match(entrega, /prepareStockChange\(d1,[\s\S]{0,120}delta: -quantity/u);
  assert.match(entrega, /await d1\.batch\(\[/u);
  assert.doesNotMatch(entrega, /applyStockChange|compens/u);
});

test("produto, SKU e saldo pertencem ao grupo; CNPJ fica somente nos eventos de consumo", () => {
  assert.match(evolutionMigration, /PRIMARY KEY \("workspace_id", "product_id", "stock_location_id"\)/u);
  assert.doesNotMatch(evolutionMigration.match(/CREATE TABLE "fdp_stock_balances"[\s\S]*?\);/u)?.[0] ?? "", /company_id/u);
  assert.match(evolutionMigration, /FOREIGN KEY \("workspace_id", "product_id"\) REFERENCES "public"\."fdp_epi_products"\("workspace_id", "id"\)/u);
  assert.match(evolutionMigration, /fdp_epi_stock_projection_guard/u);
  assert.match(evolutionMigration, /fdp_epi_stock_projection_insert_guard/u);
  assert.match(groupProductMigration, /fdp_epi_products" DROP COLUMN "company_id"/u);
  assert.match(groupProductMigration, /fdp_epi_movements" ALTER COLUMN "company_id" DROP NOT NULL/u);
  assert.match(groupProductMigration, /movement_type" IN \('registration', 'stock_entry', 'stock_transfer', 'manual_adjustment'\)[\s\S]{0,100}"company_id" IS NULL/u);
  assert.match(groupProductMigration, /fdp_epi_movements_scope_check/u);
});

test("catálogo do grupo não recebe CNPJ e o uso continua recortado por empresa", async () => {
  const products = await readFile(new URL("../app/api/epi/products/route.ts", import.meta.url), "utf8");
  const detail = await readFile(new URL("../app/api/epi/products/[id]/route.ts", import.meta.url), "utf8");
  const entry = await readFile(new URL("../app/api/epi/stock/entries/route.ts", import.meta.url), "utf8");
  const transfer = await readFile(new URL("../app/api/epi/stock/transfers/route.ts", import.meta.url), "utf8");
  const reports = await readFile(new URL("../app/api/epi/reports/route.ts", import.meta.url), "utf8");
  assert.match(products, /const assignedScope =/u);
  assert.match(products, /d\.company_id IN/u);
  assert.doesNotMatch(products, /p\.company_id|body\.companyId|loadCompany/u);
  assert.match(detail, /m\.company_id IS NULL/u);
  assert.match(detail, /fdp_member_company_access/u);
  for (const source of [entry, transfer]) {
    assert.match(source, /companyId: null, cnpj: ""/u);
    assert.doesNotMatch(source, /body\.companyId|requireCompanyAccess|loadCompany/u);
  }
  assert.doesNotMatch(reports, /c\.id = p\.company_id/u);
  assert.match(reports, /Consumo de EPI por empresa\/CNPJ/u);
});

test("a interface explica o estoque do grupo e nunca envia CNPJ ao cadastro ou à movimentação física", async () => {
  const dialogs = await readFile(new URL("../app/painel/features/epi/EpiDialogs.tsx", import.meta.url), "utf8");
  const view = await readFile(new URL("../app/painel/features/epi/EpiControlView.tsx", import.meta.url), "utf8");
  const productForm = dialogs.match(/function ProductForm[\s\S]*?function DeliveryForm/u)?.[0] ?? "";
  const stockOperations = view.match(/function StockOperations[\s\S]*?function DeliveriesPanel/u)?.[0] ?? "";
  assert.match(productForm, /Cadastro do grupo inteiro/u);
  assert.doesNotMatch(productForm, /companyId|name="companyId"/u);
  assert.match(view, /Estoque único do grupo/u);
  assert.match(stockOperations, /nunca entre CNPJs/u);
  assert.doesNotMatch(stockOperations, /companyId/u);
});

test("áreas operacionais são N:N e governam a origem e o destino das demandas", async () => {
  assert.match(evolutionMigration, /CREATE TABLE "fdp_areas"/u);
  assert.match(evolutionMigration, /CREATE TABLE "fdp_area_members"/u);
  assert.match(evolutionMigration, /fdp_area_members_workspace_area_user_uq/u);
  assert.match(evolutionMigration, /fdp_cards" ADD COLUMN "requester_area_id"/u);
  assert.match(evolutionMigration, /fdp_cards" ADD COLUMN "responsible_area_id"/u);
  for (const table of ["fdp_areas", "fdp_area_members", "fdp_area_module_assignments"]) {
    assert.match(evolutionMigration, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`, "u"));
  }
  const areaRoute = await readFile(new URL("../app/api/areas/route.ts", import.meta.url), "utf8");
  const membersRoute = await readFile(new URL("../app/api/areas/[id]/members/route.ts", import.meta.url), "utf8");
  assert.match(areaRoute, /requireNamedCapability\(workspace, "departments\.create"/u);
  assert.match(membersRoute, /requireNamedCapability\(workspace, "departments\.manage_members"/u);
});

test("aprovar desconto cria rascunho na Central sem dedução automática", async () => {
  const rota = await readFile(new URL("../app/api/epi/discounts/[id]/route.ts", import.meta.url), "utf8");
  assert.match(rota, /movement_type[\s\S]{0,180}'epi_discount'/u);
  assert.match(rota, /'draft'/u);
  assert.match(rota, /automaticDeduction: false/u);
  assert.match(rota, /validCompetence\(body\.competence\)/u);
  assert.match(evolutionMigration, /fdp_epi_discounts_movement_fk/u);
});

test("concluir higienização repõe o local no mesmo lote transacional", async () => {
  const rota = await readFile(new URL("../app/api/epi/returns/[id]/sanitization/route.ts", import.meta.url), "utf8");
  assert.match(rota, /action === "complete"[\s\S]{0,220}prepareStockChange/u);
  assert.match(rota, /sanitization_completed/u);
  assert.match(rota, /await d1\.batch\(statements\)/u);
});

test("entrada e transferência devolvem o id real do razão e preservam um local padrão", async () => {
  const service = await readFile(new URL("../lib/epi-service.ts", import.meta.url), "utf8");
  const entry = await readFile(new URL("../app/api/epi/stock/entries/route.ts", import.meta.url), "utf8");
  const transfer = await readFile(new URL("../app/api/epi/stock/transfers/route.ts", import.meta.url), "utf8");
  const locations = await readFile(new URL("../app/api/epi/stock/locations/route.ts", import.meta.url), "utf8");
  assert.match(service, /input\.id \?\? crypto\.randomUUID\(\)/u);
  assert.match(entry, /id: movementId,[\s\S]{0,160}movementType: "stock_entry"/u);
  assert.match(transfer, /id: movementId,[\s\S]{0,160}movementType: "stock_transfer"/u);
  assert.match(locations, /Number\(before\.is_default\) === 1 && !next\.isDefault/u);
});

test("os anexos do EPI contam na mesma cota de armazenamento do plano", async () => {
  const epi = await readFile(new URL("../app/api/epi/attachments/route.ts", import.meta.url), "utf8");
  const cards = await readFile(new URL("../app/api/cards/[id]/attachments/route.ts", import.meta.url), "utf8");
  for (const [nome, fonte] of [["epi", epi], ["cards", cards]] as const) {
    assert.match(fonte, /FROM fdp_card_attachments WHERE workspace_id = \?\)\s*\n?\s*\+ \(SELECT COALESCE\(SUM\(size_bytes\), 0\) FROM fdp_epi_attachments WHERE workspace_id = \?\)/u,
      `${nome} não soma as duas tabelas na cota`);
  }
  assert.match(epi, /pg_advisory_xact_lock/u);
});

test("a aba de EPIs do colaborador existe e lê a mesma fonte do módulo", async () => {
  const registros = await readFile(new URL("../app/painel/features/registrations/RegistrationsView.tsx", import.meta.url), "utf8");
  assert.match(registros, /activeTab === "epi" && employee && <EmployeeEpiPanel employeeId=\{employee\.id\}/u);
  const painel = await readFile(new URL("../app/painel/features/epi/EmployeeEpiPanel.tsx", import.meta.url), "utf8");
  assert.match(painel, /\/api\/epi\/employees\//u);
  // A aba mostra tudo o que a especificação lista, incluindo a linha do tempo.
  for (const secao of ["EPIs ativos com o colaborador", "Entregas realizadas", "Devoluções",
    "Trocas e danificações", "Descartes vinculados", "Análises de desconto",
    "Termos, anexos e evidências", "Histórico completo de movimentações"]) {
    assert.ok(painel.includes(secao), `a aba não mostra "${secao}"`);
  }
});

test("a tela avisa antes de gravar o que a escolha vai provocar", async () => {
  const dialogos = await readFile(new URL("../app/painel/features/epi/EpiDialogs.tsx", import.meta.url), "utf8");
  // A prévia usa a mesma função do servidor: duas cópias divergiriam, e a
  // pessoa confirmaria uma coisa enquanto outra acontece.
  assert.match(dialogos, /returnRouting\(condition\)/u);
  assert.match(dialogos, /damageRouting\(decision\)/u);
  assert.match(dialogos, /Abre demanda automática para o DP analisar possível desconto/u);
  assert.match(dialogos, /Nenhum valor é descontado aqui/u);
});
