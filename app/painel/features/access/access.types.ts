import type { WorkspaceRole } from "@/lib/fila-dp-types";

export type AccessMember = {
  userId: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  joinedAt: string;
  isOwner: boolean;
  isActivated: boolean;
  /** `active` ou `blocked`, definido pela administração da plataforma. */
  status: string;
  statusReason: string;
  lastSeenAt: string | null;
  companyIds: string[];
};

export type AccessCompany = { id: string; name: string; isPrincipal: boolean };

export type SeatUsage = {
  planName: string;
  planCode: string;
  subscriptionStatus: string;
  limit: number;
  used: number;
};

export type AccessOverview = {
  canManage: boolean;
  seats: SeatUsage;
  companies: AccessCompany[];
  members: AccessMember[];
};

export type ActivationLink = { url: string; expiresAt: string; name: string };
