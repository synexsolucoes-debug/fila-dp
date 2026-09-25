import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Command Center, passo 1 (§4.19): "diretoria sem visão de saúde" — a mesma
 * lacuna que `hrMetrics` não cobre (turnover e custo de folha, nada de
 * SST/ASO/obrigações). Cinco contagens que já existiam em algum módulo (ASO,
 * NR, acidentes, CAT, obrigações legais) somadas num só lugar, sem tabela
 * nova.
 */

const routeSource = await readFile(new URL("../app/api/reports/route.ts", import.meta.url), "utf8");
const panelSource = (await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8")).replaceAll("\r\n", "\n");

/* ── a rota: cada contagem, escopada por empresa, sem trazer a tabela inteira ── */

test("as cinco contagens de segurança/conformidade entram na resposta de /api/reports", () => {
  assert.match(routeSource, /safetyMetrics: \{/u);
  assert.match(routeSource, /overdueExams: overdueExams\?\.total \?\? 0/u);
  assert.match(routeSource, /overdueTrainings: overdueTrainings\?\.total \?\? 0/u);
  assert.match(routeSource, /accidentsInPeriod: accidentsInPeriod\?\.total \?\? 0/u);
  assert.match(routeSource, /catPending: catPending\?\.total \?\? 0/u);
  assert.match(routeSource, /overdueObligations: overdueObligations\?\.total \?\? 0/u);
});

test("cada contagem é feita em SQL (count), não trazendo a tabela para filtrar em memória", () => {
  assert.match(routeSource, /SELECT count\(\*\)::int AS total FROM fdp_occupational_exams/u);
  assert.match(routeSource, /SELECT count\(\*\)::int AS total FROM fdp_trainings/u);
  assert.match(routeSource, /SELECT count\(\*\)::int AS total FROM fdp_compliance_obligations/u);
  const acidentesMatches = routeSource.match(/SELECT count\(\*\)::int AS total FROM fdp_work_accidents/gu) ?? [];
  assert.equal(acidentesMatches.length, 2, "acidentes no período e CAT pendente são duas consultas separadas");
});

test("obrigação vencida usa o mesmo vocabulário de status da fonte compliance_obligation na Central de Trabalho", () => {
  assert.match(routeSource, /status IN \('open', 'in_progress', 'blocked'\) AND due_date < CURRENT_DATE/u);
});

test("o escopo por empresa é feito com ANY(?::text[]) genuinamente parametrizado, não com fragmento de SQL montado em string", () => {
  const ocorrencias = routeSource.match(/\(\?::boolean OR company_id = ANY\(\?::text\[\]\)\)/gu) ?? [];
  assert.equal(ocorrencias.length, 5, "as cinco contagens usam o mesmo primitivo de escopo");
  assert.doesNotMatch(routeSource, /\$\{companyScope/u, "nenhuma das cinco monta a cláusula por interpolação de string");
  assert.match(routeSource, /const companyIds = companyId \? \[companyId\] : \[\.\.\.companyAccess\.companyIds\]/u);
  assert.match(routeSource, /const companyUnrestricted = !companyId && companyAccess\.unrestricted/u);
});

test("CAT pendente é estado atual — não usa o recorte de período (from/to)", () => {
  const trecho = routeSource.slice(routeSource.indexOf("CAT pendente é estado atual"));
  const catQuery = trecho.slice(0, trecho.indexOf(".first<"));
  assert.doesNotMatch(catQuery, /\bfrom\b|\bto\b/u);
  assert.match(catQuery, /cat_issued = 0 AND leave_days > 0/u);
});

test("acidentes no período usa a mesma janela from/to do resto do relatório", () => {
  assert.match(routeSource, /occurred_on BETWEEN \? AND \?\s*\n\s*AND \(\?::boolean OR company_id = ANY\(\?::text\[\]\)\)`\)\s*\n\s*\.bind\(workspace\.id, from, to/u);
});

/* ── a tela: a seção existe, com os cinco números, sem inventar dado ──────── */

test("a tela mostra a seção de saúde e conformidade com os cinco números, sem valor inventado quando o relatório ainda não chegou", () => {
  assert.match(panelSource, /safety-indicators-panel/u);
  assert.match(panelSource, /Saúde e conformidade/u);
  assert.match(panelSource, /report\?\.safetyMetrics\?\.overdueExams \?\? 0/u);
  assert.match(panelSource, /report\?\.safetyMetrics\?\.overdueTrainings \?\? 0/u);
  assert.match(panelSource, /report\?\.safetyMetrics\?\.accidentsInPeriod \?\? 0/u);
  assert.match(panelSource, /report\?\.safetyMetrics\?\.catPending \?\? 0/u);
  assert.match(panelSource, /report\?\.safetyMetrics\?\.overdueObligations \?\? 0/u);
});
