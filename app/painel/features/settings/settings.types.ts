import type { WorkspaceRole, WorkspaceSnapshot } from "@/lib/fila-dp-types";

/* Tipos e rótulos que o painel e as telas de Configurações compartilham. */

export type CatalogHandler = (payload: Record<string, unknown>, message: string) => Promise<WorkspaceSnapshot | null>;

export type SnapshotMutation = (url: string, options: RequestInit, message?: string) => Promise<WorkspaceSnapshot | null>;

export type ConfirmationRequest = {
  title: string;
  description: string;
  confirmLabel: string;
  action: () => void | Promise<unknown>;
};

export type ConfirmHandler = (request: ConfirmationRequest) => void;

export const roleLabels: Record<WorkspaceRole, string> = {
  admin: "Administrador",
  member: "Membro",
  observer: "Observador",
  guest: "Convidado",
};
