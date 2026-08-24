import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ApiError } from "../lib/api-errors.ts";
import { capabilities, capabilitiesForRole, hasCapability, requireNamedCapability } from "../lib/authorization.ts";
import {
  assertDeletionConfirmation, assertLifecycleTransition, LIFECYCLE_CAPABILITY,
  lifecycleReason, nextLifecycleState, parseLifecycleAction, purgeDeadline,
  purgeRetentionDays, WORKSPACE_DELETION_IMPACT, type WorkspaceLifecycleState,
} from "../lib/workspace-lifecycle.ts";
import { OPERATIONAL_WORKSPACE_STATUSES, resolveActiveWorkspace, WORKSPACE_STATUS_LABELS, type AccessibleWorkspace } from "../lib/workspace-access.ts";

function workspace(partial: Partial<WorkspaceLifecycleState> = {}): WorkspaceLifecycleState {
  return {
    id: "ws-a", name: "Vinculato Teste", slug: "vinculato-teste",
    status: "active", deletedAt: null, purgeAfter: null, ...partial,
  };
}

function accessible(partial: Partial<AccessibleWorkspace> & { id: string }): AccessibleWorkspace {
  const status = partial.status ?? "active";
  return {
    id: partial.id, name: partial.name ?? `Grupo ${partial.id}`, timezone: "America/Sao_Paulo",
    status, statusReason: "", role: partial.role ?? "admin", isOwner: partial.isOwner ?? false,
    joinedAt: "2026-01-01", operational: partial.operational ?? status === "active",
  };
}

/* Permissões ------------------------------------------------------------- */

test("excluir o grupo não vem do papel de administrador, e sim da propriedade", () => {
  // Um administrador convidado para tocar a operação do dia a dia não pode
  // apagar demandas, cadastros e auditoria de todo mundo por engano.
  assert.equal(hasCapability("admin", "workspace.delete"), false);
  assert.equal(hasCapability({ role: "admin", isOwner: true }, "workspace.delete"), true);
  // Ser dono sem administrar também não basta.
  assert.equal(hasCapability({ role: "member", isOwner: true }, "workspace.delete"), false);
});

test("a permissão concedida nominalmente também autoriza a exclusão", () => {
  // É o caso previsto no requisito: "usuários que possuam explicitamente a
  // permissão necessária".
  assert.equal(
    hasCapability({ role: "member", extraCapabilities: new Set(["workspace.delete"]) }, "workspace.delete"),
    true,
  );
});

test("a negação individual vence até a propriedade", () => {
  assert.equal(
    hasCapability({ role: "admin", isOwner: true, deniedCapabilities: new Set(["workspace.delete"]) }, "workspace.delete"),
    false,
  );
});

test("arquivar e restaurar continuam no papel de administrador", () => {
  for (const capability of ["workspace.archive", "workspace.restore"] as const) {
    assert.equal(hasCapability("admin", capability), true, capability);
    assert.equal(hasCapability("member", capability), false, capability);
    assert.equal(hasCapability("observer", capability), false, capability);
  }
});

test("os nomes de permissão da especificação resolvem para a mesma regra", () => {
  // O produto nomeia `workspace.view` / `workspace.update` / etc.; o código já
  // usava nomes curtos gravados em concessões no banco. Os dois precisam
  // autorizar igual — senão metade do sistema libera pelo nome novo enquanto a
  // outra nega pelo antigo.
  const pairs = [
    ["workspace.view", "workspace.read"],
    ["workspace.update", "workspace.manage"],
    ["workspace.members.manage", "members.manage"],
    ["workspace.integrations.manage", "integrations.manage"],
  ] as const;
  for (const [alias, canonical] of pairs) {
    for (const role of ["admin", "member", "observer", "guest"] as const) {
      assert.equal(hasCapability(role, alias), hasCapability(role, canonical), `${role}: ${alias}`);
    }
  }
});

test("a recusa por falta de permissão diz qual permissão falta", () => {
  // "Você não tem permissão" obriga o usuário a abrir chamado para descobrir
  // qual; o nome da permissão é parte do contrato do produto e não vaza nada.
  assert.throws(
    () => requireNamedCapability("member", "workspace.delete", "excluir este grupo"),
    (error: unknown) => error instanceof ApiError
      && error.status === 403
      && error.code === "CAPABILITY_REQUIRED"
      && error.message.includes("workspace.delete")
      && error.message.includes("excluir este grupo"),
  );
});

test("toda permissão de ciclo de vida existe no catálogo de capacidades", () => {
  for (const capability of ["workspace.archive", "workspace.restore", "workspace.delete"] as const) {
    assert.ok((capabilities as readonly string[]).includes(capability), capability);
  }
  assert.ok(!capabilitiesForRole("admin").includes("workspace.delete"));
});

/* Transições ------------------------------------------------------------- */

test("cada ação de ciclo de vida exige a sua própria permissão", () => {
  assert.deepEqual(LIFECYCLE_CAPABILITY, {
    archive: "workspace.archive", restore: "workspace.restore", delete: "workspace.delete",
  });
});

test("ação desconhecida é recusada antes de tocar o banco", () => {
  for (const action of ["", "drop", "purge", "DELETE ALL"]) {
    assert.throws(
      () => parseLifecycleAction(action),
      (error: unknown) => error instanceof ApiError && error.code === "WORKSPACE_ACTION_INVALID",
    );
  }
  assert.equal(parseLifecycleAction("ARCHIVE"), "archive");
});

test("arquivar duas vezes é recusado com motivo específico", () => {
  assert.throws(
    () => assertLifecycleTransition(workspace({ status: "archived" }), "archive"),
    (error: unknown) => error instanceof ApiError && error.code === "WORKSPACE_ALREADY_ARCHIVED",
  );
});

test("restaurar um grupo já ativo é recusado, e restaurar arquivado funciona", () => {
  assert.throws(
    () => assertLifecycleTransition(workspace({ status: "active" }), "restore"),
    (error: unknown) => error instanceof ApiError && error.code === "WORKSPACE_ALREADY_ACTIVE",
  );
  assert.doesNotThrow(() => assertLifecycleTransition(workspace({ status: "archived" }), "restore"));
});

test("suspensão comercial não é desfeita pelo próprio cliente", () => {
  // Restaurar por aqui contornaria a cobrança.
  for (const status of ["suspended", "canceled"]) {
    assert.throws(
      () => assertLifecycleTransition(workspace({ status }), "restore"),
      (error: unknown) => error instanceof ApiError && error.code === "WORKSPACE_STATUS_NOT_RESTORABLE",
      status,
    );
  }
});

test("grupo excluído é restaurável dentro do prazo e recusado depois dele", () => {
  const deletedAt = new Date("2026-08-01T10:00:00Z");
  const deleted = workspace({
    status: "deleted",
    deletedAt: deletedAt.toISOString(),
    purgeAfter: purgeDeadline(deletedAt, 30).toISOString(),
  });
  assert.doesNotThrow(() => assertLifecycleTransition(deleted, "restore", new Date("2026-08-20T10:00:00Z")));
  assert.throws(
    () => assertLifecycleTransition(deleted, "restore", new Date("2026-10-01T10:00:00Z")),
    (error: unknown) => error instanceof ApiError && error.code === "WORKSPACE_PURGE_WINDOW_EXPIRED",
  );
});

test("excluir duas vezes é recusado", () => {
  assert.throws(
    () => assertLifecycleTransition(workspace({ status: "deleted", deletedAt: new Date().toISOString() }), "delete"),
    (error: unknown) => error instanceof ApiError && error.code === "WORKSPACE_ALREADY_DELETED",
  );
});

/* Confirmação e estado --------------------------------------------------- */

test("a exclusão exige confirmação explícita e o identificador digitado", () => {
  const target = workspace();
  assert.throws(
    () => assertDeletionConfirmation(target, { confirmation: "vinculato-teste" }),
    (error: unknown) => error instanceof ApiError && error.code === "WORKSPACE_CONFIRMATION_REQUIRED",
  );
  // Digitar o identificador é o que impede o clique cair no grupo errado quando
  // a pessoa administra vários grupos parecidos.
  assert.throws(
    () => assertDeletionConfirmation(target, { confirmed: true, confirmation: "vinculato-producao" }),
    (error: unknown) => error instanceof ApiError && error.code === "WORKSPACE_CONFIRMATION_MISMATCH",
  );
  assert.doesNotThrow(() => assertDeletionConfirmation(target, { confirmed: true, confirmation: "vinculato-teste" }));
});

test("a exclusão exige um motivo com substância; arquivar não", () => {
  assert.throws(
    () => lifecycleReason("teste", "delete"),
    (error: unknown) => error instanceof ApiError && error.code === "WORKSPACE_DELETE_REASON_REQUIRED",
  );
  assert.equal(lifecycleReason("Encerramento do contrato com o cliente.", "delete"), "Encerramento do contrato com o cliente.");
});

test("arquivar exige motivo porque o banco exige — e a recusa precisa dizer isso", () => {
  // O CHECK `fdp_workspaces_status_reason_check` obriga motivo em todo estado
  // que não seja `active`. Sem validar aqui, o UPDATE violaria a constraint e o
  // usuário receberia o 500 genérico em vez de uma instrução.
  assert.throws(
    () => lifecycleReason("", "archive"),
    (error: unknown) => error instanceof ApiError
      && error.status === 400
      && error.code === "WORKSPACE_ARCHIVE_REASON_REQUIRED",
  );
  assert.equal(lifecycleReason("Operação encerrada temporariamente.", "archive"), "Operação encerrada temporariamente.");
  // Restaurar leva o grupo a `active`, estado que o CHECK não cobre.
  assert.equal(lifecycleReason("", "restore"), "");
});

test("a exclusão é reversível: grava a data e o prazo de recuperação", () => {
  const now = new Date("2026-08-13T12:00:00Z");
  const next = nextLifecycleState("delete", now);
  assert.equal(next.status, "deleted");
  assert.equal(next.deletedAt, now.toISOString());
  assert.ok(next.purgeAfter && new Date(next.purgeAfter) > now, "sem prazo não há como restaurar");

  assert.deepEqual(nextLifecycleState("archive"), { status: "archived", deletedAt: null, purgeAfter: null });
  // Restaurar limpa as marcas de exclusão: um grupo ativo com data de exclusão
  // seria expurgado mais tarde por um trabalho de manutenção.
  assert.deepEqual(nextLifecycleState("restore"), { status: "active", deletedAt: null, purgeAfter: null });
});

test("o prazo de recuperação é configurável dentro de limites sãos", () => {
  assert.equal(purgeRetentionDays("7"), 7);
  assert.equal(purgeRetentionDays("0"), 1, "prazo zero tornaria a exclusão irreversível na prática");
  assert.equal(purgeRetentionDays("9999"), 365);
  assert.equal(purgeRetentionDays("qualquer coisa"), 30);
  assert.equal(purgeRetentionDays(undefined), 30);
});

test("a confirmação avisa o que a exclusão atinge", () => {
  const impact = WORKSPACE_DELETION_IMPACT.join(" ");
  for (const term of ["usuários", "demandas", "integrações", "empresas", "colaboradores", "documentos", "histórico"]) {
    assert.ok(impact.includes(term), `a confirmação precisa citar ${term}`);
  }
});

/* Acesso ----------------------------------------------------------------- */

test("grupo excluído não é contexto de trabalho, mas não tranca o usuário", () => {
  // O cenário do requisito: arquivar ou excluir um grupo não pode bloquear o
  // login de quem participa de outro.
  assert.equal(OPERATIONAL_WORKSPACE_STATUSES.has("deleted"), false);
  assert.equal(WORKSPACE_STATUS_LABELS.deleted, "Excluído");

  for (const status of ["archived", "deleted", "suspended"]) {
    const result = resolveActiveWorkspace(
      [accessible({ id: "ativo" }), accessible({ id: "parado", status, operational: false })],
      "parado",
    );
    assert.equal(result.kind, "ok", status);
    assert.equal(result.kind === "ok" && result.workspace.id, "ativo", status);
    // A troca é anunciada em vez de acontecer em silêncio.
    assert.equal(result.kind === "ok" && result.switchedFrom?.id, "parado", status);
  }
});

/* Backend manda ---------------------------------------------------------- */

test("a rota valida a permissão no servidor e não aceita workspace do cliente", async () => {
  const route = await readFile(new URL("../app/api/workspace/lifecycle/route.ts", import.meta.url), "utf8");
  // O grupo alvo vem da sessão. Aceitar um id do corpo criaria um IDOR: bastaria
  // trocar o identificador para arquivar o grupo de outra empresa.
  assert.match(route, /getWorkspaceContext\(auth\.user\)/u);
  assert.doesNotMatch(route, /body\.workspaceId|params\.workspaceId/u);

  const authorization = route.indexOf("hasCapability(workspace, capability)");
  const update = route.indexOf("UPDATE fdp_workspaces");
  assert.ok(authorization > 0 && authorization < update, "a permissão é conferida antes da escrita");
  // Tentativa negada vira evento de segurança, não silêncio.
  assert.match(route, /outcome: "denied"/u);
  assert.match(route, /workspace\.lifecycle_denied/u);
});

test("a migration prevê o estado excluído com data e prazo coerentes", async () => {
  const migration = await readFile(
    new URL("../drizzle/postgres/0037_integration_events_and_workspace_lifecycle.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /"status" IN \('active', 'suspended', 'canceled', 'archived', 'deleted'\)/u);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "deleted_at"/u);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "purge_after"/u);
  // Estado e data andam juntos: um grupo excluído sem data não teria como ser
  // restaurado com prazo nem expurgado.
  assert.match(migration, /\("status" = 'deleted'\) = \("deleted_at" IS NOT NULL\)/u);
});
