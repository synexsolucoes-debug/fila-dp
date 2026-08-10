import type { WorkspaceRole } from "@/lib/fila-dp-types";
import type { AccessCompany, AccessMember, AccessOverview, ActivationLink, SeatUsage } from "./access.types";

type Row = Record<string, unknown>;
const object = (input: unknown): Row => (input && typeof input === "object" && !Array.isArray(input) ? input as Row : {});
const text = (input: unknown) => (input == null ? "" : String(input));
const bool = (input: unknown) => input === true || input === 1 || input === "true" || input === "1";
const strings = (input: unknown) => (Array.isArray(input) ? input.map(text).filter(Boolean) : []);
const validRoles = new Set<WorkspaceRole>(["admin", "member", "observer", "guest"]);
const role = (input: unknown): WorkspaceRole => (validRoles.has(input as WorkspaceRole) ? input as WorkspaceRole : "guest");

export async function requestAccess<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error || payload.message || "Não foi possível concluir a operação.");
  return payload;
}

function normalizeMember(input: unknown): AccessMember {
  const row = object(input);
  return {
    userId: text(row.userId), email: text(row.email), name: text(row.name) || text(row.email),
    role: role(row.role), joinedAt: text(row.joinedAt),
    isOwner: bool(row.isOwner), isActivated: bool(row.isActivated),
    status: text(row.status) || "active", statusReason: text(row.statusReason),
    lastSeenAt: row.lastSeenAt ? text(row.lastSeenAt) : null,
    companyIds: strings(row.companyIds),
  };
}

export async function loadAccessOverview(): Promise<AccessOverview> {
  const payload = await requestAccess<Record<string, unknown>>("/api/members/access");
  const seats = object(payload.seats);
  return {
    canManage: bool(payload.canManage),
    seats: {
      planName: text(seats.planName), planCode: text(seats.planCode),
      subscriptionStatus: text(seats.subscriptionStatus) || "none",
      limit: Number(seats.limit) || 0, used: Number(seats.used) || 0,
    } satisfies SeatUsage,
    companies: (Array.isArray(payload.companies) ? payload.companies : []).map((item): AccessCompany => {
      const row = object(item);
      return { id: text(row.id), name: text(row.name), isPrincipal: bool(row.isPrincipal) };
    }),
    members: (Array.isArray(payload.members) ? payload.members : []).map(normalizeMember),
  };
}

/** Cria o usuário e devolve o link de ativação quando ele ainda não tem senha. */
export async function inviteMember(input: { name: string; email: string; role: WorkspaceRole; companyIds: string[] }) {
  const payload = await requestAccess<{ activation?: unknown }>("/api/members", {
    method: "POST",
    body: JSON.stringify(input),
  });
  const activation = object(payload.activation);
  return activation.url
    ? { url: text(activation.url), expiresAt: text(activation.expiresAt), name: text(activation.name) } satisfies ActivationLink
    : null;
}

export async function updateMemberAccess(userId: string, input: { role?: WorkspaceRole; companyIds?: string[] }) {
  await requestAccess(`/api/members/${userId}`, { method: "PATCH", body: JSON.stringify(input) });
}

export async function removeMember(userId: string) {
  await requestAccess(`/api/members/${userId}`, { method: "DELETE" });
}

export async function createActivationLink(userId: string): Promise<ActivationLink> {
  const payload = await requestAccess<Record<string, unknown>>(`/api/members/${userId}/recovery`, { method: "POST" });
  return { url: text(payload.recoveryUrl), expiresAt: text(payload.expiresAt), name: text(payload.memberName) };
}
