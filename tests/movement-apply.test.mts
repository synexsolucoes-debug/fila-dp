import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { movementEmploymentEffect } from "../lib/operations.ts";

/**
 * Motor de Jornadas, passo 1 (§4.16): `fdp_employee_movements` já cobria
 * afastamento e desligamento como movimentação aprovável, mas nada nunca
 * levava o status até "applied" — a coluna aceitava o valor no CHECK e
 * nenhuma rota o usava. Estes testes cobrem a função pura que decide o efeito
 * sobre o cadastro, e a rota que a usa dentro da mesma transação.
 */

/* ── `movementEmploymentEffect` ───────────────────────────────────────────── */

test("afastamento e desligamento têm efeito sobre a situação do colaborador; o resto não", () => {
  assert.deepEqual(movementEmploymentEffect("leave"), { employmentStatus: "on_leave", requiredCurrentStatus: "active" });
  assert.deepEqual(movementEmploymentEffect("termination"), { employmentStatus: "terminated", requiredCurrentStatus: "active" });
  for (const type of ["salary_change", "vacation", "transfer", "benefit_change", "registration_sync", "epi_discount", "other"]) {
    assert.equal(movementEmploymentEffect(type), null);
  }
});

/* ── a rota de aplicação ──────────────────────────────────────────────────── */

test("só uma movimentação aprovada pode ser aplicada", async () => {
  const source = await readFile(new URL("../app/api/operations/movements/[id]/apply/route.ts", import.meta.url), "utf8");
  assert.match(source, /movement\.status !== "approved"/u);
  assert.match(source, /MOVEMENT_NOT_APPLIABLE/u);
});

test("a situação do colaborador precisa bater com o que a movimentação espera", async () => {
  const source = await readFile(new URL("../app/api/operations/movements/[id]/apply/route.ts", import.meta.url), "utf8");
  assert.match(source, /EMPLOYEE_STATUS_CONFLICT/u);
  assert.match(source, /movement\.employee_status !== effect\.requiredCurrentStatus/u);
});

test("a guarda contra duplo clique está na condição do UPDATE, não só na checagem antes dele", async () => {
  const source = await readFile(new URL("../app/api/operations/movements/[id]/apply/route.ts", import.meta.url), "utf8");
  assert.match(source, /SET status = 'applied'[\s\S]*WHERE workspace_id = \? AND id = \? AND status = 'approved'/u);
  assert.match(source, /SET employment_status = \?[\s\S]*WHERE workspace_id = \? AND id = \? AND employment_status = \?/u);
});

test("aplicar desligamento com data do último dia trabalhado grava termination_date", async () => {
  const source = await readFile(new URL("../app/api/operations/movements/[id]/apply/route.ts", import.meta.url), "utf8");
  assert.match(source, /details\.lastWorkingDate/u);
  assert.match(source, /SET employment_status = \?, termination_date = \?/u);
});

test("aplicar grava a movimentação e o cadastro na mesma transação, com auditoria", async () => {
  const source = await readFile(new URL("../app/api/operations/movements/[id]/apply/route.ts", import.meta.url), "utf8");
  assert.match(source, /d1\.batch\(statements\)/u);
  assert.match(source, /movement\.applied/u);
  assert.match(source, /requireCapability\(workspace, "movements\.manage"\)/u);
  assert.match(source, /requireCompanyAccess/u);
});

/* ── a tela: botão "Aplicar" só para quem gerencia, só quando aprovada ─────── */

test("a tela só mostra Aplicar para movimentação aprovada e para quem tem a permissão", async () => {
  const source = await readFile(new URL("../app/painel/features/operations/OperationsView.tsx", import.meta.url), "utf8");
  assert.match(source, /canManage && item\.status === "approved" && <button[^>]*onClick=\{\(\) => onApply\(item\.id\)\}/u);
  assert.match(source, /\/api\/operations\/movements\/\$\{id\}\/apply/u);
});
