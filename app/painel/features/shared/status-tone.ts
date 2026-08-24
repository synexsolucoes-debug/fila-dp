/**
 * Vocabulário de estados do painel (§16).
 *
 * Separado do componente de propósito: é dado, não interface. Cada módulo tinha
 * o seu mapa — Operações chamava `in_progress` de atenção, Cadastros nem o
 * conhecia, SaaS mantinha um terceiro só para cobrança — e o mesmo verde
 * significava coisas diferentes em telas que a mesma pessoa abre no mesmo dia.
 */

export type PanelTone = "neutral" | "safe" | "warning" | "danger" | "info";

const TONES: Record<string, PanelTone> = {
  // Concluído, validado, vigente.
  active: "safe", approved: "safe", closed: "safe", completed: "safe", resolved: "safe",
  published: "safe", paid: "safe", reconciled: "safe", applied: "safe", connected: "safe",
  trialing: "safe",
  // Recusado, travado, quebrado.
  rejected: "danger", blocked: "danger", critical: "danger", failed: "danger", error: "danger",
  canceled: "danger", unpaid: "danger", uncollectible: "danger",
  // Em curso ou aguardando alguém.
  pending: "warning", pending_approval: "warning", in_progress: "warning", warning: "warning",
  review: "warning", approval: "warning", invoice_pending: "warning", open: "warning",
  suspended: "warning", on_leave: "warning", degraded: "warning", past_due: "warning",
  dismissed: "warning",
  // Pronto para a próxima etapa — informativo, não é conclusão nem alerta.
  ready_to_pay: "info", reopened: "info", submitted: "info",
};

/**
 * Tom de um status. O desconhecido cai em `neutral`, que é legível: a versão
 * anterior deste mapa deixava o estado sem regra herdar a cor do contêiner e
 * "Aplicada" saía em 1.29:1, praticamente invisível.
 *
 * Onde a política do módulo diverge de verdade — um conector externo em estado
 * que o painel não reconhece é sinal, não ruído — o componente aceita `tone`
 * explícito. Divergir na chamada é honesto; divergir numa segunda cópia do
 * componente é como o painel chegou a cinco selos diferentes.
 */
export const statusTone = (status: string): PanelTone => TONES[status] ?? "neutral";
