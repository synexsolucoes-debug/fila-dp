import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { hasCapability, type Capability } from "../lib/authorization.ts";
import { actionDefinitions } from "../lib/action-center.ts";

test("todo indicador da central de ação tem consulta real, destino e capability válida", () => {
  assert.ok(actionDefinitions.length >= 10);
  const keys = new Set<string>();
  for (const definition of actionDefinitions) {
    assert.match(definition.key, /^[a-z][a-z0-9_]*$/u, `chave inválida: ${definition.key}`);
    assert.equal(keys.has(definition.key), false, `chave duplicada: ${definition.key}`);
    keys.add(definition.key);
    assert.ok(definition.label.length > 3, `${definition.key} precisa de rótulo`);
    assert.ok(definition.description.length > 3, `${definition.key} precisa de descrição`);
    assert.ok(["critical", "warning", "neutral"].includes(definition.tone));
    // Destino real: cada indicador leva a uma tela existente do painel.
    assert.ok(["processes", "auxiliary", "psychologistPayments", "contractorPayments", "timeTracking", "integrations", "board"].includes(definition.target));
    // Capability existente e sempre escopada ao workspace da sessão.
    assert.equal(hasCapability("admin", definition.capability as Capability), true, `${definition.key} usa capability inexistente`);
    assert.match(definition.sql, /workspace_id = \?/u, `${definition.key} não filtra por workspace`);
    // O contrato do UNION é o formato da coluna, não a forma da contagem.
    assert.match(definition.sql, /count\([^)]*\)::int AS total/u);
    assert.match(definition.sql, /AS earliest/u);
    assert.match(definition.sql, /AS amount/u);
    if (definition.companyColumn) assert.ok(definition.sql.includes("{{company}}"), `${definition.key} não aplica escopo de empresa`);
  }
});

test("a central de ação respeita o papel: observador e convidado não veem o que não podem abrir", () => {
  const visible = (role: string) => actionDefinitions.filter((definition) => hasCapability(role, definition.capability as Capability)).map((item) => item.key);
  const admin = visible("admin");
  const member = visible("member");
  const observer = visible("observer");
  const guest = visible("guest");

  assert.equal(admin.length, actionDefinitions.length);
  assert.ok(member.includes("movements_pending"));
  assert.ok(member.includes("psychology_payments_pending"));
  assert.equal(member.includes("integration_reconciliations"), false);
  // Observador não acompanha pagamento de psicólogos nem movimentações.
  assert.equal(observer.includes("psychology_payments_pending"), false);
  assert.equal(observer.includes("movements_pending"), false);
  assert.ok(observer.includes("contractor_closings_pending"));
  // Convidado só enxerga demandas.
  assert.deepEqual(guest, ["demands_overdue"]);
});

test("os indicadores financeiros expõem valor e os operacionais expõem prazo", () => {
  const byKey = new Map(actionDefinitions.map((definition) => [definition.key, definition]));
  for (const key of ["psychology_payments_pending", "contractor_closings_pending", "contractor_invoice_divergent", "complement_pending"]) {
    assert.equal(byKey.get(key)?.showsAmount, true, `${key} deveria exibir valor`);
    assert.match(byKey.get(key)!.sql, /sum\(/u);
  }
  for (const key of ["pending_items_blocking", "closing_items_pending", "obligations_due"]) {
    assert.match(byKey.get(key)!.sql, /min\(/u, `${key} deveria expor o prazo mais próximo`);
  }
  // Fechamento já pago não é pagamento pendente.
  assert.match(byKey.get("psychology_payments_pending")!.sql, /NOT IN \('paid', 'closed'\)/u);
  assert.match(byKey.get("contractor_closings_pending")!.sql, /NOT IN \('paid', 'closed'\)/u);
});

test("a rota da central de ação agrega em uma consulta e valida a chave do indicador", async () => {
  const source = await readFile(new URL("../app/api/dashboard/action-center/route.ts", import.meta.url), "utf8");
  assert.match(source, /getWorkspaceContext/);
  assert.doesNotMatch(source, /getWorkspaceSnapshot/);
  assert.match(source, /getCompanyAccessScope/);
  assert.match(source, /requireCompanyAccess/);
  assert.match(source, /hasCapability\(workspace, definition\.capability\)/);
  // Uma única ida ao banco: os blocos são unidos, não consultados um a um.
  assert.match(source, /UNION ALL/);
  assert.match(source, /Indicador com chave inválida/);
});

test("a busca global cobre os domínios do produto respeitando capability e escopo de empresa", async () => {
  const source = await readFile(new URL("../app/api/search/route.ts", import.meta.url), "utf8");
  for (const [capability, table] of [
    ["companies.read", "fdp_companies"],
    ["employees.read", "fdp_employees"],
    ["psychology.payments.read", "fdp_auxiliary_providers"],
    ["contractors.payments.read", "fdp_contractor_profiles"],
    ["competences.read", "fdp_payroll_cycles"],
    ["integrations.status.read", "fdp_integrations"],
  ] as const) {
    assert.ok(source.includes(`hasCapability(workspace, "${capability}")`), `busca não protege ${capability}`);
    assert.ok(source.includes(table), `busca não cobre ${table}`);
  }
  assert.match(source, /companyFilter\("e\.company_id"\)/);
  assert.match(source, /companyFilter\("p\.company_id"\)/);
  assert.match(source, /companyFilter\("k\.company_id"\)/);
});

test("a busca por CPF usa HMAC e nunca devolve o documento em claro", async () => {
  const source = await readFile(new URL("../app/api/search/route.ts", import.meta.url), "utf8");
  assert.match(source, /protectCpf/);
  assert.match(source, /e\.cpf_hash = \?/);
  assert.match(source, /e\.cpf_last4 = \?/);
  // O hash é usado como filtro, jamais projetado na resposta.
  assert.doesNotMatch(source, /SELECT[^;]*cpf_hash[^;]*FROM fdp_employees/u);
  assert.match(source, /maskedCpf/);
});

test("a central de ação é clicável, acessível e não inventa números", async () => {
  const [component, workspace] = await Promise.all([
    readFile(new URL("../app/painel/features/action-center/ActionCenter.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /<ActionCenter onNavigate=\{onNavigate\} \/>/);
  assert.match(workspace, /onNavigate=\{\(target\) => setView\(target\)\}/);
  // Cada indicador é um botão que navega para o módulo responsável.
  assert.match(component, /onClick=\{\(\) => onNavigate\(item\.target\)\}/);
  assert.match(component, /items\.filter\(\(item\) => item\.count > 0\)/);
  assert.match(component, /aria-labelledby="action-center-title"/);
  assert.match(component, /aria-live="polite"/);
  assert.match(component, /role="alert"/);
  assert.match(component, /Carregando indicadores/);
  assert.match(component, /Nenhuma pendência aberta/);
  assert.doesNotMatch(component, /Math\.random|localStorage|sessionStorage/);
});

test("a paleta de busca é um diálogo modal de verdade: Esc fecha, foco fica preso e volta", async () => {
  const source = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(source, /if \(event\.key === "Escape"\) \{ event\.preventDefault\(\); setSearchOpen\(false\); return; \}/);
  assert.match(source, /if \(event\.key !== "Tab"\) return;/);
  assert.match(source, /previous\?\.focus\(\)/);
  assert.match(source, /ref=\{searchPanelRef\}/);
  assert.match(source, /role="listbox"/);
  assert.match(source, /searchRecords\.map/);
  assert.match(source, /Registros da operação/);
});

test("o estilo da central de ação respeita foco visível e movimento reduzido", async () => {
  const css = await readFile(new URL("../app/painel/features/action-center/action-center.module.css", import.meta.url), "utf8");
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /@media \(max-width: 720px\)/);
});
