import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canRespondForDemands, responsibleColumns } from "../app/painel/features/board/board.model.ts";
import type { WorkspaceMember } from "../lib/fila-dp-types.ts";

/**
 * Quem não tem o módulo Demandas não aparece no quadro nem como responsável.
 *
 * Relato do produto: no quadro por responsável apareciam colunas de pessoas de
 * outro departamento, que não têm acesso ao painel de demandas. A coluna era um
 * alvo de arrasto para alguém que não consegue abrir a demanda.
 */
function membro(name: string, patch: Partial<WorkspaceMember> = {}): WorkspaceMember {
  return {
    userId: `u-${name.toLowerCase().replace(/\s/gu, "-")}`,
    email: `${name.toLowerCase().replace(/\s/gu, ".")}@exemplo.com`,
    name,
    role: "member",
    joinedAt: "2026-01-01T00:00:00",
    isOwner: false,
    isActivated: true,
    companyIds: [],
    departmentId: "dp",
    departmentName: "Departamento Pessoal",
    boardAccess: true,
    employeeId: null,
    employeeName: "",
    ...patch,
  };
}

test("pessoa sem o módulo Demandas não vira coluna no quadro por responsável", () => {
  const colunas = responsibleColumns([], [
    membro("Ana Ribeiro"),
    membro("Rafael Lima", { departmentName: "Financeiro", boardAccess: false }),
  ]);
  assert.deepEqual(colunas.map((coluna) => coluna.name), ["Ana Ribeiro"]);
});

test("só admin e membro com o módulo Demandas podem responder por demanda", () => {
  assert.equal(canRespondForDemands(membro("Ana")), true);
  assert.equal(canRespondForDemands(membro("Bia", { role: "admin" })), true);
  assert.equal(canRespondForDemands(membro("Caio", { boardAccess: false })), false);
  assert.equal(canRespondForDemands(membro("Dora", { role: "observer" })), false);
  // Snapshot antigo, sem o campo: segue o comportamento anterior.
  assert.equal(canRespondForDemands(membro("Eva", { boardAccess: undefined })), true);
});

test("o servidor recusa atribuir demanda a quem não tem o módulo Demandas", async () => {
  const relations = await readFile(new URL("../lib/fila-dp-relations.ts", import.meta.url), "utf8");
  assert.match(relations, /MEMBER_HAS_BOARD_ACCESS_SQL/u);
  assert.match(relations, /ASSIGNEE_WITHOUT_BOARD_ACCESS/u);
  const snapshot = await readFile(new URL("../lib/fila-dp-db.ts", import.meta.url), "utf8");
  assert.match(snapshot, /\$\{MEMBER_HAS_BOARD_ACCESS_SQL\} AS board_access/u);
});

test("a regra SQL segue a mesma ordem do menu: exceção, proprietário, departamento", async () => {
  const { MEMBER_HAS_BOARD_ACCESS_SQL } = await import("../lib/member-board-access.ts");
  const exception = MEMBER_HAS_BOARD_ACCESS_SQL.indexOf("fdp_member_module_grants");
  const owner = MEMBER_HAS_BOARD_ACCESS_SQL.indexOf("w.owner_user_id = wm.user_id");
  const department = MEMBER_HAS_BOARD_ACCESS_SQL.indexOf("fdp_area_module_assignments");
  assert.ok(exception >= 0 && owner > exception && department > owner);
  assert.match(MEMBER_HAS_BOARD_ACCESS_SQL, /module_key = 'board'/u);
});
