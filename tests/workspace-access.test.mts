import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  noAccessibleWorkspaceError, resolveActiveWorkspace, type AccessibleWorkspace,
} from "../lib/workspace-access.ts";

/**
 * O defeito que estes testes protegem: arquivar o workspace que estava
 * selecionado trancava a pessoa para fora do produto inteiro, mesmo com
 * associação ativa em outro grupo. A resolução lia a preferência sem olhar o
 * ciclo de vida e depois recusava a requisição em vez de procurar alternativa.
 */

function workspace(partial: Partial<AccessibleWorkspace> & { id: string }): AccessibleWorkspace {
  const status = partial.status ?? "active";
  return {
    id: partial.id,
    name: partial.name ?? `Grupo ${partial.id}`,
    timezone: "America/Sao_Paulo",
    status,
    statusReason: partial.statusReason ?? "",
    role: partial.role ?? "member",
    isOwner: partial.isOwner ?? false,
    joinedAt: partial.joinedAt ?? "2026-01-01",
    operational: partial.operational ?? status === "active",
  };
}

test("workspace preferido válido é mantido", () => {
  const list = [workspace({ id: "a" }), workspace({ id: "b" })];
  const result = resolveActiveWorkspace(list, "a");
  assert.equal(result.kind, "ok");
  assert.equal(result.kind === "ok" && result.workspace.id, "a");
  assert.equal(result.kind === "ok" && result.switchedFrom, null);
});

test("preferido arquivado cai para outro grupo ativo em vez de trancar o usuário", () => {
  // Este é o bug relatado, na forma mínima.
  const list = [workspace({ id: "b" }), workspace({ id: "a", status: "archived", operational: false })];
  const result = resolveActiveWorkspace(list, "a");
  assert.equal(result.kind, "ok", "usuário com grupo ativo nunca pode ficar sem contexto");
  assert.equal(result.kind === "ok" && result.workspace.id, "b");
  // A troca é anunciada: mudar o contexto em silêncio confunde mais do que ajuda.
  assert.equal(result.kind === "ok" && result.switchedFrom?.id, "a");
});

test("suspenso e cancelado também não servem como contexto de trabalho", () => {
  for (const status of ["suspended", "canceled", "archived"]) {
    const list = [workspace({ id: "ativo" }), workspace({ id: "parado", status, operational: false })];
    const result = resolveActiveWorkspace(list, "parado");
    assert.equal(result.kind === "ok" && result.workspace.id, "ativo", `${status} não pode ser contexto`);
  }
});

test("sem nenhum grupo operacional, devolve o motivo de cada um em vez de recusa genérica", () => {
  const list = [
    workspace({ id: "a", name: "Alfa", status: "archived", statusReason: "encerrou contrato", operational: false }),
    workspace({ id: "b", name: "Beta", status: "suspended", statusReason: "inadimplência", operational: false }),
  ];
  const result = resolveActiveWorkspace(list, "a");
  assert.equal(result.kind, "none");
  const error = noAccessibleWorkspaceError(result.kind === "none" ? result.blocked : []);
  assert.equal(error.code, "NO_ACTIVE_WORKSPACE");
  assert.equal(error.status, 403);
  assert.match(error.message, /Alfa \(arquivado\)/u);
  assert.match(error.message, /Beta \(suspenso\)/u);
  // O detalhe estruturado permite a tela listar os grupos e seus motivos.
  assert.equal((error.details?.workspaces as unknown[]).length, 2);
});

test("usuário sem nenhuma associação recebe orientação de convite", () => {
  const error = noAccessibleWorkspaceError([]);
  assert.equal(error.code, "NO_ACTIVE_WORKSPACE");
  assert.match(error.message, /convite/iu);
});

test("a escolha é determinística: proprietário antes de associado comum", () => {
  // A ordem chega pronta da consulta; o resolvedor não pode embaralhar.
  const list = [workspace({ id: "dono", isOwner: true }), workspace({ id: "outro" })];
  const result = resolveActiveWorkspace(list, "inexistente");
  assert.equal(result.kind === "ok" && result.workspace.id, "dono");
});

test("a resolução de contexto usa o serviço central, não uma consulta própria", async () => {
  const source = await readFile(new URL("../lib/fila-dp-db.ts", import.meta.url), "utf8");
  assert.match(source, /listAccessibleWorkspaces\(d1, userRow\.id\)/u);
  assert.match(source, /resolveActiveWorkspace\(accessible, preference/u);
  assert.match(source, /noAccessibleWorkspaceError\(resolution\.blocked\)/u);
  // A recusa antiga, que derrubava a sessão por causa de um grupo parado, saiu.
  assert.doesNotMatch(source, /"WORKSPACE_SUSPENDED"/u);
  // E a lista do seletor passa a sair do mesmo serviço, com status.
  assert.match(source, /availableWorkspaces: accessible\.map/u);
});

test("entrar em outra conta encerra a sessão sem reabrir logout por GET", async () => {
  const route = await readFile(new URL("../app/api/auth/logout/route.ts", import.meta.url), "utf8");
  // A troca era um LINK para uma rota só-POST: o GET voltava 405, a sessão
  // sobrevivia e o usuário caía na mesma conta. A correção é um formulário
  // POST — logout por GET continua proibido, porque prefetch e <img> o
  // disparariam sem o usuário pedir.
  assert.doesNotMatch(route, /export async function GET/u, "logout por GET seria disparado por prefetch");
  assert.match(route, /export async function POST/u);
  assert.match(route, /status: 303/u, "envio de formulário precisa redirecionar, não devolver JSON");
  assert.match(route, /no-store/u);
  // O destino da troca é constante: `return_to` do usuário não entra nessa
  // decisão, então ela não pode virar redirecionamento aberto.
  assert.match(route, /switching \? "\/login\?trocar=1" : redirectTarget\(request\)/u);

  const login = await readFile(new URL("../app/login/page.tsx", import.meta.url), "utf8");
  assert.match(login, /<form method="post" action="\/api\/auth\/logout">/u);
  // Com `trocar=1` a tela não pode oferecer "continuar" com a identidade antiga.
  assert.match(login, /const switching = query\.trocar === "1"/u);
  assert.match(login, /const user = switching \? null : await getChatGPTUser\(\)/u);
});

test("o painel separa sair de entrar em outra conta", async () => {
  const panel = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(panel, /switch-account-button/u);
  assert.match(panel, /<form method="post" action="\/api\/auth\/logout">/u);
  assert.match(panel, /aria-label="Entrar em outra conta"/u);
  assert.match(panel, /aria-label="Sair do Vinculato"/u);
});
