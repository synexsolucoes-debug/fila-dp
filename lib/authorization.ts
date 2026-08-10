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

export function hasCapability(role: string, capability: Capability) {
  if (!Object.hasOwn(roleCapabilities, role)) return false;
  return roleCapabilities[role as WorkspaceRole].has(capability);
}

export function requireCapability(role: string, capability: Capability) {
  if (!hasCapability(role, capability)) {
    throw ApiError.forbidden("Você não tem permissão para realizar esta ação.", "CAPABILITY_REQUIRED");
  }
}
