import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Command Center, passo 1 (§4.19): "diretoria sem visão de saúde" — a mesma
 * lacuna que `hrMetrics` não cobre (turnover e custo de folha, nada de
 * SST/ASO). Quatro contagens que já existiam em algum módulo (ASO, NR,
 * acidentes, CAT) somadas num só lugar, sem tabela nova.
 */

const routeSource = await readFile(new URL("../app/api/reports/route.ts", import.meta.url), "utf8");
const panelSource = (await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8")).replaceAll("\r\n", "\n");

/* ── a rota: cada contagem, escopada por empresa, sem trazer a tabela inteira ── */

test("as quatro contagens de segurança/conformidade entram na resposta de /api/reports", () => {
  assert.match(routeSource, /safetyMetrics: \{/u);
  assert.match(routeSource, /overdueExams: overdueExams\?\.total \?\? 0/u);
  assert.match(routeSource, /overdueTrainings: overdueTrainings\?\.total \?\? 0/u);
  assert.match(routeSource, /accidentsInPeriod: accidentsInPeriod\?\.total \?\? 0/u);
  assert.match(routeSource, /catPending: catPending\?\.total \?\? 0/u);
});

test("cada contagem é feita em SQL (count), não trazendo a tabela para filtrar em memória", () => {
  assert.match(routeSource, /SELECT count\(\*\)::int AS total FROM fdp_occupational_exams/u);
  assert.match(routeSource, /SELECT count\(\*\)::int AS total FROM fdp_trainings/u);
  const acidentesMatches = routeSource.match(/SELECT count\(\*\)::int AS total FROM fdp_work_accidents/gu) ?? [];
  assert.equal(acidentesMatches.length, 2, "acidentes no período e CAT pendente são duas consultas separadas");
});

test("o escopo por empresa é o mesmo em admin (sem filtro), empresa única e restrito (IN), e nega tudo sem acesso", () => {
  assert.match(routeSource, /company_id = \?/u);
  assert.match(routeSource, /company_id IN \(\$\{\[\.\.\.companyAccess\.companyIds\]\.map/u);
  assert.match(routeSource, /AND false/u);
});

test("CAT pendente é estado atual — não usa o recorte de período (from/to)", () => {
  const trecho = routeSource.slice(routeSource.indexOf("CAT pendente é estado atual"));
  const catQuery = trecho.slice(0, trecho.indexOf(".first<"));
  assert.doesNotMatch(catQuery, /\bfrom\b|\bto\b/u);
  assert.match(catQuery, /cat_issued = 0 AND leave_days > 0/u);
});

test("acidentes no período usa a mesma janela from/to do resto do relatório", () => {
  assert.match(routeSource, /occurred_on BETWEEN \? AND \? \$\{companyScope\.sql\}`\)\s*\n\s*\.bind\(workspace\.id, from, to/u);
});

/* ── a tela: a seção existe, com os quatro números, sem inventar dado ─────── */

test("a tela mostra a seção de saúde e conformidade com os quatro números, sem valor inventado quando o relatório ainda não chegou", () => {
  assert.match(panelSource, /safety-indicators-panel/u);
  assert.match(panelSource, /Saúde e conformidade/u);
  assert.match(panelSource, /report\?\.safetyMetrics\?\.overdueExams \?\? 0/u);
  assert.match(panelSource, /report\?\.safetyMetrics\?\.overdueTrainings \?\? 0/u);
  assert.match(panelSource, /report\?\.safetyMetrics\?\.accidentsInPeriod \?\? 0/u);
  assert.match(panelSource, /report\?\.safetyMetrics\?\.catPending \?\? 0/u);
});
