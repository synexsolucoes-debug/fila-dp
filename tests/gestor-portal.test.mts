import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Portal do Gestor, passo 1 (§4.20): "DP como central telefônica" — a
 * diretoria e o roteiro de produto nomearam o Portal do Gestor como P1, com
 * quatro peças (catálogo, acompanhamento, minhas pendências, minha equipe).
 * "Minha equipe" foi escolhida como a primeira fatia porque as outras três
 * dependem dela — sem saber quem cada gestor gerencia, não há o que
 * catalogar, acompanhar ou enfileirar.
 *
 * `fdp_employees.manager_employee_id` já existia desde a fundação dos
 * cadastros (0013) e já tinha um consumidor real (guarda de exclusão em
 * app/api/employees/[id]/route.ts), mas nada nunca respondia "quem esta
 * pessoa gerencia" — e nenhuma tela jamais preenchia esse campo. A peça que
 * faltava de verdade era outra: uma conta de plataforma (fdp_users) e um
 * colaborador (fdp_employees) são dois cadastros sem ligação nenhuma. Este
 * passo fecha as duas lacunas: o vínculo conta↔colaborador
 * (`fdp_workspace_members.employee_id`, novo) e a tela que finalmente lê
 * `manager_employee_id` para responder "quem é minha equipe".
 *
 * Por que vínculo explícito, não e-mail: `fdp_employees.email` é opcional e
 * não único (0013 não tem UNIQUE nela) — um e-mail em branco casaria com
 * qualquer conta sem vínculo, inflando a equipe de qualquer gestor com
 * colaboradores que não têm nada a ver com ele.
 */

const migrationSource = await readFile(new URL("../drizzle/postgres/0104_manager_portal_link.sql", import.meta.url), "utf8");
const membersRouteSource = await readFile(new URL("../app/api/members/[id]/route.ts", import.meta.url), "utf8");
const teamRouteSource = await readFile(new URL("../app/api/gestor/team/route.ts", import.meta.url), "utf8");
const portalPageSource = await readFile(new URL("../app/gestor/GestorTeamView.tsx", import.meta.url), "utf8");
const workspaceAppSource = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
const registrationsViewSource = await readFile(new URL("../app/painel/features/registrations/RegistrationsView.tsx", import.meta.url), "utf8");

/* ── a migration: o vínculo é opcional, único, e nunca arrasta a conta ──── */

test("employee_id em fdp_workspace_members é nulo por padrão, único por colaborador, e SET NULL ao remover o colaborador", () => {
  assert.match(migrationSource, /ALTER TABLE "fdp_workspace_members" ADD COLUMN "employee_id" text;/u);
  assert.match(migrationSource, /REFERENCES "public"\."fdp_employees"\("workspace_id", "id"\) ON DELETE SET NULL/u);
  assert.match(migrationSource, /CREATE UNIQUE INDEX "fdp_workspace_members_workspace_employee_uq"\s*\n\s*ON "fdp_workspace_members" \("workspace_id", "employee_id"\) WHERE "employee_id" IS NOT NULL;/u);
});

/* ── PATCH /api/members/[id]: quem pode vincular, e as recusas ──────────── */

test("vincular um colaborador exige que ele pertença ao workspace e não esteja vinculado a outra conta", () => {
  assert.match(membersRouteSource, /MEMBER_EMPLOYEE_NOT_FOUND/u);
  assert.match(membersRouteSource, /MEMBER_EMPLOYEE_ALREADY_LINKED/u);
  assert.match(membersRouteSource, /SELECT id FROM fdp_employees WHERE workspace_id = \? AND id = \?/u);
  assert.match(membersRouteSource, /SELECT user_id FROM fdp_workspace_members WHERE workspace_id = \? AND employee_id = \? AND user_id <> \?/u);
});

test("employeeId ausente no corpo não mexe no vínculo atual; string vazia remove", () => {
  assert.match(membersRouteSource, /if \(Object\.hasOwn\(body, "employeeId"\)\)/u);
  assert.match(membersRouteSource, /employeeId = raw \|\| null/u);
  assert.match(membersRouteSource, /if \(employeeId !== undefined\)/u);
});

/* ── GET /api/gestor/team: autosserviço, sem parâmetro de entrada ───────── */

test("a rota não aceita nenhum recorte de entrada — é sempre a própria conta autenticada", () => {
  assert.doesNotMatch(teamRouteSource, /searchParams/u);
  assert.match(teamRouteSource, /SELECT employee_id FROM fdp_workspace_members WHERE workspace_id = \? AND user_id = \?/u);
  assert.match(teamRouteSource, /\.bind\(workspace\.id, user\.id\)/u);
});

test("conta sem colaborador vinculado nunca chega a montar a consulta da equipe", () => {
  assert.match(teamRouteSource, /if \(!employeeId\) return Response\.json\(\{ linked: false, team: \[\] \}\);/u);
});

test("a equipe é filtrada por manager_employee_id e só colaboradores ativos, sem trazer a tabela inteira", () => {
  assert.match(teamRouteSource, /WHERE e\.workspace_id = \? AND e\.manager_employee_id = \? AND e\.employment_status = 'active'/u);
});

/* ── a tela: três estados distintos, nenhum inventado ────────────────────── */

test("a tela distingue 'sem vínculo' de 'equipe vazia' — não são a mesma mensagem", () => {
  assert.match(portalPageSource, /!state\.data\.linked/u);
  assert.match(portalPageSource, /ainda não está vinculada a um colaborador/u);
  assert.match(portalPageSource, /state\.data\.team\.length === 0/u);
  assert.match(portalPageSource, /não tem ninguém reportando/u);
});

/* ── as duas pontas do vínculo, na UI que já existe ──────────────────────── */

test("a tela de usuários e acessos ganha o vínculo conta→colaborador, buscando em vez de listar tudo", () => {
  assert.match(workspaceAppSource, /function MemberEmployeeLink/u);
  assert.match(workspaceAppSource, /updateMemberEmployeeLink/u);
  assert.match(workspaceAppSource, /\/api\/employees\?search=\$\{encodeURIComponent\(trimmed\)\}&status=active&limit=8/u);
});

test("a ficha do colaborador ganha o campo Gestor, escopado à mesma empresa e excluindo o próprio colaborador", () => {
  assert.match(registrationsViewSource, /function EmployeeManagerPicker/u);
  assert.match(registrationsViewSource, /companyId=\$\{encodeURIComponent\(companyId\)\}&status=active&limit=8/u);
  assert.match(registrationsViewSource, /\.filter\(\(row\) => text\(row\.id\) !== employeeId\)/u);
  assert.match(registrationsViewSource, /managerEmployeeId: employee\.managerEmployeeId \?\? ""/u);
});
