import type { ActivityEvent } from "@/lib/fila-dp-types";

/**
 * Formatação usada pela Visão geral e pelo restante do painel.
 *
 * Saiu de `WorkspaceApp.tsx` junto com a Visão geral: as duas pontas usam as
 * mesmas datas, rótulos de SLA e frases de atividade, e copiar seria ter duas
 * versões da mesma leitura.
 */

export function formatDate(value: string | null, long = false) {
  if (!value || typeof value !== "string") return "Sem prazo";
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "Sem prazo";
  return new Intl.DateTimeFormat("pt-BR", long ? { day: "2-digit", month: "long", year: "numeric" } : { day: "2-digit", month: "short" }).format(date);
}

export function compactSlaLabel(status: string, dueAt: string | null) {
  if (status === "overdue") return "Atrasada";
  if (status === "warning") return "Vence hoje";
  if (status === "paused") return "Pausada";
  if (status === "completed") return "Concluída";
  return dueAt ? formatDate(dueAt) : "Sem prazo";
}

export function formatMoment(value: string) {
  const raw = String(value ?? "").trim();
  if (!raw) return "agora";
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T") + "Z";
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return "agora";
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function activityLabel(activity: ActivityEvent) {
  const labels: Record<string, string> = {
    "card.created": "criou a demanda",
    "card.updated": "atualizou os dados",
    "card.moved": "moveu a demanda de coluna",
    "card.archived": "arquivou a demanda",
    "card.commented": "adicionou um comentário",
    "checklist.item_added": "adicionou uma etapa ao checklist",
    "checklist.item_toggled": activity.payload.completed ? "concluiu uma etapa" : "reabriu uma etapa",
    "inbox.item_converted": "converteu a solicitação da Inbox",
    "attachment.uploaded": "enviou um anexo",
    "attachment.deleted": "removeu um anexo",
    "tangerino.attachments.authorized": "autorizou os anexos da Sólides",
    "tangerino.attachments.completed": "trouxe os anexos da Sólides",
    "admission.sheet.built": "leu a ficha de contratação",
    "admission.sheet.purged": "apagou a ficha de contratação",
    "card.restored": "restaurou a demanda",
    "automation.executed": "executou uma automação",
    /* Processo e automação na mesma linha do tempo (§45). Sem estas entradas, o
       histórico dizia "atualizou a demanda" justamente nos eventos que
       explicam por que ela mudou de etapa. */
    "process.instance_started": "abriu a demanda a partir de um processo",
    "process.step_advanced": "avançou a etapa do processo",
    "integration.demand_created": "abriu a demanda a partir de uma leitura automática",
    "teams.movement_confirmed": "confirmou uma movimentação vinda do Teams",
    "sla.paused": "pausou o SLA",
    "sla.resumed": "retomou o SLA",
    /* A troca de responsável tem linha própria (§16, §41). Enquanto ela passava
       pelo `PATCH` genérico, o histórico dizia "atualizou os dados" no evento
       que a operação mais precisa reconstituir — "quem me passou isso, e
       quando?". */
    "card.assigned": activity.payload.to ? `atribuiu a demanda a ${String(activity.payload.to)}` : "devolveu a demanda para a fila comum",
    "card.bulk_updated": "alterou a demanda junto com outras",
  };
  return labels[activity.eventType] ?? "atualizou a demanda";
}

export function activityDetails(activity: ActivityEvent) {
  const payload = activity.payload && typeof activity.payload === "object" && !Array.isArray(activity.payload) ? activity.payload : {};
  if (activity.eventType === "card.moved") {
    return [`De ${String(payload.fromListName ?? "coluna anterior")} para ${String(payload.toListName ?? "nova coluna")}.`];
  }
  if (activity.eventType === "card.assigned") {
    const de = String(payload.from ?? "");
    return [de ? `Antes com ${de}.` : "Estava sem responsável."];
  }
  if (activity.eventType === "card.bulk_updated") {
    const total = Number(payload.selectionSize ?? 0);
    return [`${String(payload.summary ?? "alteração em massa")}${total > 1 ? ` (${total} demandas na mesma ação).` : "."}`];
  }
  if (activity.eventType === "checklist.item_toggled") {
    const state = payload.completed ? "concluída" : "reaberta";
    return [payload.title ? `Etapa: ${String(payload.title)} (${state}).` : `Etapa ${state}.`];
  }
  if (activity.eventType === "attachment.uploaded" || activity.eventType === "attachment.deleted") {
    return payload.filename ? [`Arquivo: ${String(payload.filename)}.`] : [];
  }
  if (activity.eventType === "process.step_advanced") {
    const destino = String(payload.toStepLabel ?? payload.toStepId ?? "próxima etapa");
    const agente = payload.agentKey ? ` Proposta do agente ${String(payload.agentKey)}, confirmada por uma pessoa.` : "";
    return [`Para ${destino}.${agente}`];
  }
  if (activity.eventType === "process.instance_started") {
    return [`Processo ${String(payload.processName ?? payload.processDefinitionId ?? "")} ${String(payload.versionNumber ?? "")}`.trim()];
  }
  if (activity.eventType === "integration.demand_created") {
    return [`Origem: ${String(payload.source ?? "integração")}.`];
  }
  const changes = payload.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];
  const labels: Record<string, string> = { title: "Título", description: "Descrição", company: "Empresa", processType: "Processo", priority: "Prioridade", assigneeName: "Responsável", dueAt: "Prazo", name: "Nome", slaBehavior: "Comportamento do SLA" };
  return Object.entries(changes).flatMap(([field, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const change = value as { from?: unknown; to?: unknown };
    if (change.from === undefined && change.to === undefined) return [];
    const from = String(change.from ?? "sem valor") || "sem valor";
    const to = String(change.to ?? "sem valor") || "sem valor";
    return [`${labels[field] ?? field}: ${from} → ${to}.`];
  });
}

export const plural = (n: number, um: string, muitos: string) => `${n} ${n === 1 ? um : muitos}`;
