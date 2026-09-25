import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildWorkDigestQueries, workDigestEmailHtml, workDigestFromRows,
} from "../lib/work-digest.ts";
import { hasCapability } from "../lib/authorization.ts";
import { workItemSources } from "../lib/work-items.ts";

/* ── `workDigestFromRows` ─────────────────────────────────────────────────── */

test("sem itens vencidos, workDigestFromRows devolve null — nunca um resumo vazio", () => {
  assert.equal(workDigestFromRows({ overdue: 0 }, []), null);
  assert.equal(workDigestFromRows(null, []), null);
});

test("workDigestFromRows recorta a página em 10 itens e mantém o total vencido", () => {
  const rows = Array.from({ length: 15 }, (_unused, index) => ({
    source_type: "card", source_id: `c${index}`, title: `Demanda ${index}`,
    status: "overdue", due_at: "2026-01-01",
  }));
  const digest = workDigestFromRows({ overdue: 23 }, rows);
  assert.ok(digest);
  assert.equal(digest?.items.length, 10);
  assert.equal(digest?.overdueTotal, 23);
});

/* ── `workDigestEmailHtml` ────────────────────────────────────────────────── */

test("workDigestEmailHtml lista os itens, escapa o título e informa quantos ficaram de fora", () => {
  const digest = workDigestFromRows({ overdue: 3 }, [
    { source_type: "card", source_id: "c1", title: "<script>alert(1)</script>", status: "overdue", due_at: "2026-01-01", company_name: "Acme" },
    { source_type: "epi_ca_expiry", source_id: "e1", title: "CA vencendo", status: "warning", due_at: "2026-01-02" },
  ]);
  assert.ok(digest);
  const html = workDigestEmailHtml("Grupo Acme", digest!, "https://app.exemplo.com/");
  assert.doesNotMatch(html, /<script>/u);
  assert.match(html, /Grupo Acme/u);
  assert.match(html, /3 itens vencidos/u);
  assert.match(html, /href="https:\/\/app\.exemplo\.com\/painel\/demandas\/c1"/u);
  assert.match(html, /E mais 1 item vencido/u);
});

test("workDigestEmailHtml no singular quando só há um item vencido e nenhum oculto", () => {
  const digest = workDigestFromRows({ overdue: 1 }, [
    { source_type: "card", source_id: "c1", title: "Demanda única", status: "overdue", due_at: "2026-01-01" },
  ]);
  const html = workDigestEmailHtml("Grupo Acme", digest!, "https://app.exemplo.com");
  assert.match(html, /1 item vencido precisa/u);
  assert.doesNotMatch(html, /E mais/u);
});

/* ── `buildWorkDigestQueries` ─────────────────────────────────────────────── */

test("buildWorkDigestQueries filtra por vencidos e não usa o escopo 'somente meus'", () => {
  const queries = buildWorkDigestQueries("workspace-1");
  assert.ok(queries);
  assert.match(queries!.page.sql, /due_at IS NOT NULL AND due_at::date < CURRENT_DATE/u);
  // Escopo "team": nenhuma condição de dono/atribuído entra na união.
  assert.doesNotMatch(queries!.page.sql, /assignee_id = \?|created_by = \?/u);
  assert.match(queries!.counts.sql, /count\(\*\) FILTER \(WHERE due_at IS NOT NULL AND due_at::date < CURRENT_DATE\)::int AS overdue/u);
});

/* ── o resumo cobre toda fonte que um admin veria em /api/work (§4.12) ────── */

test("o resumo diário já inclui ASO e treinamento vencidos, sem precisar de extensão (§4.12 atualizado pelo §4.15)", () => {
  // §4.12 registrou occupational_exam_due/training_due como fontes comuns da
  // Central de Trabalho antes do resumo diário existir. O resumo (§4.15) lê
  // `workItemSources` inteiro — não uma lista própria — então as duas fontes
  // já entram automaticamente para quem tem `exams.view`/`trainings.view`,
  // que é o caso do papel admin.
  const adminSources = workItemSources.filter((source) => hasCapability({ role: "admin" }, source.capability));
  const keys = adminSources.map((source) => source.key);
  assert.ok(keys.includes("occupational_exam_due"), "ASO vencido deve estar entre as fontes do admin");
  assert.ok(keys.includes("training_due"), "treinamento vencido deve estar entre as fontes do admin");
});

/* ── a rota agendada: autenticação, endereço público e idempotência ───────── */

test("a rota do resumo diário exige Bearer e aceita CRON_SECRET ou o segredo próprio", async () => {
  const route = await readFile(new URL("../app/api/cron/work-digest/route.ts", import.meta.url), "utf8");
  assert.match(route, /CRON_SECRET/u);
  assert.match(route, /FDP_WORK_DIGEST_CRON_SECRET/u);
  assert.match(route, /timingSafeEqual/u);
});

test("a rota do resumo diário não monta nada sem FDP_APP_URL configurado", async () => {
  const route = await readFile(new URL("../app/api/cron/work-digest/route.ts", import.meta.url), "utf8");
  assert.match(route, /if \(!baseUrl\) break;/u);
});

test("a chave de idempotência do resumo diário inclui workspace, destinatário e o dia", async () => {
  const route = await readFile(new URL("../app/api/cron/work-digest/route.ts", import.meta.url), "utf8");
  assert.match(route, /idempotencyKey:\s*`work-digest:\$\{workspace\.id\}:\$\{admin\.id\}:\$\{today\}`/u);
});

test("só administradores recebem o resumo — a consulta de destinatários filtra role = 'admin'", async () => {
  const route = await readFile(new URL("../app/api/cron/work-digest/route.ts", import.meta.url), "utf8");
  assert.match(route, /m\.role = 'admin'/u);
});
