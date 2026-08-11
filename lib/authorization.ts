import { ApiError } from "./api-errors.ts";
import type { WorkspaceRole } from "./fila-dp-types";

export const capabilities = [
  "workspace.read",
  "workspace.manage",
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
  "saas.read",
  "saas.manage",
  "audit.read",
  "companies.read",
  "companies.manage",
  "employees.read",
  "employees.manage",
  "registrations.catalogs.manage",
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
] as const;

export type Capability = typeof capabilities[number];

const roleCapabilities = {
  admin: new Set<Capability>(capabilities),
  member: new Set<Capability>([
    "workspace.read", "members.directory.read", "cards.read", "cards.write", "comments.write",
    "attachments.read", "attachments.write", "reports.read", "hr.read", "hr.write",
    "integrations.status.read",
    "companies.read", "employees.read", "employees.manage", "registrations.catalogs.manage",
    "processes.read", "competences.read", "competences.manage", "competences.transition",
    "movements.read", "movements.manage", "approvals.read", "approvals.request", "approvals.decide",
    "obligations.read", "obligations.manage", "pending_items.read", "pending_items.manage",
    "benefits.read", "benefits.manage", "psychology.read", "psychology.manage",
    "contractors.read", "contractors.manage", "auxiliary.approvals.request", "auxiliary.approvals.decide", "auxiliary.close",
    "psychology.payments.read", "psychology.payments.manage", "psychology.payments.close",
    "contractors.payments.read", "contractors.payments.manage", "contractors.payments.close",
    "time.read", "time.manage", "time.approve", "time.export",
  ]),
  observer: new Set<Capability>([
    "workspace.read", "members.directory.read", "cards.read", "attachments.read", "reports.read",
    "integrations.status.read",
    "companies.read", "employees.read",
    "processes.read", "competences.read", "obligations.read", "pending_items.read",
    "benefits.read", "contractors.read", "contractors.payments.read", "time.read",
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
};

function subjectOf(subject: AuthorizationSubject) {
  return typeof subject === "string" ? { role: subject } : subject;
}

export function hasCapability(subject: AuthorizationSubject, capability: Capability) {
  const { role, extraCapabilities, deniedCapabilities } = subjectOf(subject);
  // A negação individual vence o papel: é a exceção restritiva, e uma exceção
  // restritiva que pode ser contornada não é restrição.
  if (deniedCapabilities?.has(capability)) return false;
  if (extraCapabilities?.has(capability)) return true;
  if (!Object.hasOwn(roleCapabilities, role)) return false;
  return roleCapabilities[role as WorkspaceRole].has(capability);
}

export function requireCapability(subject: AuthorizationSubject, capability: Capability) {
  if (!hasCapability(subject, capability)) {
    throw ApiError.forbidden("Você não tem permissão para realizar esta ação.", "CAPABILITY_REQUIRED");
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
