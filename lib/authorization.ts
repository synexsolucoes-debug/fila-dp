import { ApiError } from "./api-errors.ts";
import type { WorkspaceRole } from "./fila-dp-types";

export const capabilities = [
  "workspace.read",
  "workspace.manage",
  // Ciclo de vida do grupo, separado de `workspace.manage` de propósito:
  // renomear o grupo e apagá-lo não são o mesmo risco e não podem depender da
  // mesma permissão.
  "workspace.archive",
  "workspace.restore",
  "workspace.delete",
  "members.directory.read",
  "members.manage",
  "cards.read",
  "cards.write",
  "comments.write",
  "attachments.read",
  "attachments.write",
  "reports.read",
  "hr.read",
  "hr.write",
  "integrations.status.read",
  "integrations.manage",
  "integrations.run",
  "integrations.reconcile",
  "integrations.view",
  "integrations.credentials.manage",
  "integrations.execute",
  "integrations.logs.view",
  "saas.read",
  "saas.manage",
  "audit.read",
  "companies.read",
  "companies.manage",
  "employees.read",
  "employees.manage",
  "registrations.catalogs.manage",
  "departments.view",
  "departments.create",
  "departments.edit",
  "departments.manage_members",
  "departments.archive",
  "processes.read",
  "processes.manage",
  "processes.publish",
  "competences.read",
  "competences.manage",
  "competences.transition",
  "competences.reopen",
  "movements.read",
  "movements.manage",
  "approvals.read",
  "approvals.request",
  "approvals.decide",
  "obligations.read",
  "obligations.manage",
  "pending_items.read",
  "pending_items.manage",
  "benefits.read",
  "benefits.manage",
  "psychology.read",
  "psychology.manage",
  "contractors.read",
  "contractors.manage",
  "auxiliary.approvals.request",
  "auxiliary.approvals.decide",
  "auxiliary.close",
  "psychology.payments.read",
  "psychology.payments.manage",
  "psychology.payments.close",
  "contractors.payments.read",
  "contractors.payments.manage",
  "contractors.payments.close",
  "contractors.limits.manage",
  "contractors.export_caju",
  "payments.reopen",
  "time.read",
  "time.manage",
  "time.approve",
  "time.export",
  "time.mappings.manage",
  // Controle de EPI. As ações estão separadas porque as consequências são
  // diferentes: entregar move estoque, descartar é irreversível, e analisar
  // desconto decide sobre o salário de alguém.
  "epi.view",
  "epi.create",
  "epi.edit",
  "epi.delete",
  "epi.deliver",
  "epi.return",
  "epi.damage",
  "epi.dispose",
  "epi.discount.analyze",
  "epi.export",
  "epi.audit.view",
  "epi.stock.adjust",
] as const;

export type Capability = typeof capabilities[number];

/**
 * Nomes alternativos aceitos para a mesma permissão.
 *
 * A especificação do produto nomeia as permissões de grupo como
 * `workspace.view` / `workspace.update` / `workspace.members.manage` /
 * `workspace.integrations.manage`; o código já usava nomes mais curtos, gravados
 * em concessões individuais no banco. Traduzir aqui deixa os dois vocabulários
 * válidos sem migrar dado nem duplicar a regra — e sem o risco de uma metade do
 * sistema autorizar por um nome enquanto a outra nega pelo outro.
 */
const capabilityAliases = {
  "workspace.view": "workspace.read",
  "workspace.update": "workspace.manage",
  "workspace.members.manage": "members.manage",
  "workspace.integrations.manage": "integrations.manage",
} as const satisfies Record<string, Capability>;

export type CapabilityAlias = keyof typeof capabilityAliases;
export type CapabilityName = Capability | CapabilityAlias;

function resolveCapability(name: CapabilityName): Capability {
  return (capabilityAliases as Record<string, Capability>)[name] ?? name as Capability;
}

/**
 * Permissões que o papel de administrador **não** concede sozinho.
 *
 * Excluir o grupo apaga demandas, colaboradores, empresas, documentos e a
 * trilha de auditoria de todo mundo que trabalha nele. Um administrador
 * convidado para tocar a operação do dia a dia não deveria conseguir fazer isso
 * por engano; quem pode é o proprietário, o administrador da plataforma, ou
 * alguém a quem a permissão foi concedida nominalmente.
 */
const ownerOnlyCapabilities = new Set<Capability>(["workspace.delete"]);

const roleCapabilities = {
  admin: new Set<Capability>(capabilities.filter((capability) => !ownerOnlyCapabilities.has(capability))),
  member: new Set<Capability>([
    "workspace.read", "members.directory.read", "cards.read", "cards.write", "comments.write",
    "attachments.read", "attachments.write", "reports.read", "hr.read", "hr.write",
    "integrations.status.read", "integrations.view",
    "companies.read", "employees.read", "employees.manage", "registrations.catalogs.manage",
    "departments.view", "departments.create", "departments.edit", "departments.manage_members", "departments.archive",
    "processes.read", "competences.read", "competences.manage", "competences.transition",
    "movements.read", "movements.manage", "approvals.read", "approvals.request", "approvals.decide",
    "obligations.read", "obligations.manage", "pending_items.read", "pending_items.manage",
    "benefits.read", "benefits.manage", "psychology.read", "psychology.manage",
    "contractors.read", "contractors.manage", "auxiliary.approvals.request", "auxiliary.approvals.decide", "auxiliary.close",
    "psychology.payments.read", "psychology.payments.manage", "psychology.payments.close",
    "contractors.payments.read", "contractors.payments.manage", "contractors.payments.close",
    "time.read", "time.manage", "time.approve", "time.export",
    // O analista de DP opera o EPI inteiro: é ele quem entrega, recebe de
    // volta, trata a troca e leva o caso de desconto ao parecer. O que fica
    // fora é apagar cadastro e ler a trilha de auditoria — as duas ações que
    // servem para encobrir as outras, e por isso ficam com o administrador.
    "epi.view", "epi.create", "epi.edit", "epi.deliver", "epi.return", "epi.damage",
    "epi.dispose", "epi.discount.analyze", "epi.export", "epi.stock.adjust",
  ]),
  observer: new Set<Capability>([
    "workspace.read", "members.directory.read", "cards.read", "attachments.read", "reports.read",
    "integrations.status.read", "integrations.view",
    "companies.read", "employees.read", "departments.view",
    "processes.read", "competences.read", "obligations.read", "pending_items.read",
    "benefits.read", "contractors.read", "contractors.payments.read", "time.read",
    "epi.view",
  ]),
  guest: new Set<Capability>([
    "workspace.read", "members.directory.read", "cards.read", "comments.write",
  ]),
} satisfies Record<WorkspaceRole, ReadonlySet<Capability>>;

/**
 * Quem está sendo autorizado.
 *
 * Ou o papel sozinho — a forma antiga, ainda usada onde não há exceção
 * individual — ou o contexto do workspace, que carrega as capacidades extras
 * concedidas àquela pessoa. Aceitar as duas formas evita que a permissão por
 * usuário valha em alguns pontos e não em outros, que é pior que não existir.
 */
export type AuthorizationSubject = string | {
  role: string;
  /** Capacidades concedidas ao usuário além do papel. */
  extraCapabilities?: ReadonlySet<string>;
  /** Módulos bloqueados para o usuário, mesmo que o papel permita. */
  deniedCapabilities?: ReadonlySet<string>;
  /** Proprietário do grupo — única forma de obter as permissões restritas ao dono. */
  isOwner?: boolean;
};

function subjectOf(subject: AuthorizationSubject) {
  return typeof subject === "string" ? { role: subject } : subject;
}

export function hasCapability(subject: AuthorizationSubject, capabilityName: CapabilityName) {
  const capability = resolveCapability(capabilityName);
  const { role, extraCapabilities, deniedCapabilities, isOwner } = subjectOf(subject);
  // A negação individual vence o papel: é a exceção restritiva, e uma exceção
  // restritiva que pode ser contornada não é restrição.
  if (deniedCapabilities?.has(capability)) return false;
  // A concessão nominal também vale para as permissões restritas ao dono: é
  // exatamente o caso "usuário com a permissão concedida explicitamente".
  if (extraCapabilities?.has(capability)) return true;
  if (ownerOnlyCapabilities.has(capability)) {
    // O papel sozinho não basta: além de ser dono, precisa administrar o grupo.
    return isOwner === true && role === "admin";
  }
  if (!Object.hasOwn(roleCapabilities, role)) return false;
  return roleCapabilities[role as WorkspaceRole].has(capability);
}

export function requireCapability(subject: AuthorizationSubject, capabilityName: CapabilityName) {
  if (!hasCapability(subject, capabilityName)) {
    throw ApiError.forbidden("Você não tem permissão para realizar esta ação.", "CAPABILITY_REQUIRED");
  }
}

/**
 * Recusa com o nome da permissão que falta.
 *
 * "Você não tem permissão" obriga o usuário a abrir um chamado para descobrir
 * qual. Dizer o nome não vaza nada — a permissão já é parte do contrato do
 * produto — e transforma a recusa em algo que o administrador do grupo resolve
 * sozinho.
 */
export function requireNamedCapability(subject: AuthorizationSubject, capabilityName: CapabilityName, action: string) {
  if (!hasCapability(subject, capabilityName)) {
    throw ApiError.forbidden(
      `Você não tem permissão para ${action}. É necessária a permissão ${capabilityName}, concedida ao proprietário do grupo ou por um administrador da plataforma.`,
      "CAPABILITY_REQUIRED",
    );
  }
}

/**
 * Capacidades de um papel, em ordem estável.
 *
 * A tela de usuários precisa mostrar o que cada papel concede — sem isso o
 * administrador escolhe "Membro" ou "Observador" no escuro. A lista sai daqui,
 * da mesma estrutura que a autorização usa, e não de uma cópia em outro arquivo.
 */
export function capabilitiesForRole(role: WorkspaceRole): Capability[] {
  return capabilities.filter((capability) => roleCapabilities[role].has(capability));
}

export const workspaceRoles = ["admin", "member", "observer", "guest"] as const;
