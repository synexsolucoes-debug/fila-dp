"use client";

import { ArrowRight } from "lucide-react";
import { formatDate } from "../overview/formatting";
import type { Card, WorkspaceSnapshot } from "@/lib/fila-dp-types";

/* Como uma demanda aparece nas listas do painel: cor do processo, prazo,
   situação do SLA e o caminho entre áreas. Compartilhado entre o
   WorkspaceApp e as telas que saíram dele. */

export const processColors: Record<string, string> = {
  "CONCILIAÇÃO CADASTRAL": "blue",
  "FÉRIAS": "purple",
  "BENEFÍCIOS": "green",
  "RESCISÃO": "orange",
  "CADASTRO": "gray",
  "FOLHA": "red",
  "OUTROS": "gray",
};

export function formatDue(value: string | null) {
  if (!value || typeof value !== "string") return "Sem prazo";
  if (!value.includes("T")) return formatDate(value);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return formatDate(value);
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function formatReceived(value: string) {
  // Inbox items can come from SQLite as `YYYY-MM-DD HH:mm:ss`, from an API
  // as an ISO string, or briefly have no timestamp while a webhook is being
  // processed. Never render `NaN` when the value cannot be parsed.
  const raw = String(value ?? "").trim();
  if (!raw) return "agora";
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const date = new Date(normalized + (/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? "" : "Z"));
  if (Number.isNaN(date.getTime())) return "agora";
  const diffMinutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  if (diffMinutes < 60) return `há ${diffMinutes || 1} min`;
  if (diffMinutes < 1440) return `há ${Math.floor(diffMinutes / 60)} h`;
  return `há ${Math.floor(diffMinutes / 1440)} d`;
}

export function slaLabel(card: Card) {
  if (card.slaStatus === "overdue") return `Atrasada • ${formatDue(card.dueAt)}`;
  if (card.slaStatus === "warning") return card.dueAt ? `Atenção • ${formatDue(card.dueAt)}` : "Atenção no SLA";
  if (card.slaStatus === "paused") return "SLA pausado";
  if (card.slaStatus === "completed") return "Concluída";
  return card.dueAt ? formatDue(card.dueAt) : "Sem prazo";
}

/**
 * Origem e destino são parte do processo operacional, não uma etiqueta livre.
 * O cartão recebe somente os IDs; os nomes configuráveis são resolvidos pelo
 * catálogo do workspace para que renomear uma área não deixe snapshots textuais
 * espalhados pelas demandas.
 */
export function DemandAreaFlow({ card, areas }: { card: Card; areas: WorkspaceSnapshot["areas"] }) {
  if (!card.requesterAreaId && !card.responsibleAreaId) return null;
  const requester = areas.find((area) => area.id === card.requesterAreaId)?.name ?? "Área não informada";
  const responsible = areas.find((area) => area.id === card.responsibleAreaId)?.name ?? "Área não informada";
  return <span className="demand-area-flow" aria-label={`Fluxo entre áreas: ${requester} para ${responsible}`}>
    <span>{requester}</span><ArrowRight aria-hidden="true" /><span>{responsible}</span>
  </span>;
}
