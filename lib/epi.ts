/**
 * Vocabulário e regras do Controle de EPI.
 *
 * Este arquivo é **puro**: nenhum import, nenhum acesso a banco, nenhuma
 * dependência de ambiente. É a única cópia do vocabulário do módulo, e ela
 * precisa valer nos dois lados — o servidor valida com ela, a tela rotula com
 * ela. Duas cópias significariam a tela dizendo "Devolvido higienizado" para um
 * estado que o banco chama de outra coisa, e a divergência só apareceria no
 * relatório de alguém.
 *
 * As três decisões operacionais do módulo também moram aqui, como funções e não
 * como `if` espalhado pelas rotas:
 *
 *  - `returnRouting`: a condição da devolução decide o destino do EPI. Não é o
 *    usuário que marca "volta ao estoque" — é a condição que determina, e a
 *    tela mostra o resultado antes de gravar.
 *  - `damageRouting`: a decisão da análise de dano decide o que acontece com o
 *    equipamento velho e com o novo.
 *  - `discountTitle`: o título da demanda aberta para o DP.
 *
 * Desconto nunca é lançado por nenhuma delas. O máximo que uma rotina faz é
 * dizer que existe um caso a analisar; quem decide é o Departamento Pessoal, na
 * demanda.
 */

export const epiTypes = [
  "head", "eye_face", "hearing", "respiratory", "trunk",
  "upper_limbs", "lower_limbs", "full_body", "fall_protection", "other",
] as const;
export type EpiType = typeof epiTypes[number];

export const epiTypeLabels: Record<EpiType, string> = {
  head: "Proteção da cabeça",
  eye_face: "Proteção dos olhos e face",
  hearing: "Proteção auditiva",
  respiratory: "Proteção respiratória",
  trunk: "Proteção do tronco",
  upper_limbs: "Proteção dos membros superiores",
  lower_limbs: "Proteção dos membros inferiores",
  full_body: "Proteção do corpo inteiro",
  fall_protection: "Proteção contra quedas",
  other: "Outro",
};

/**
 * Estado da **unidade** de EPI: onde a peça física está e em que condição.
 *
 * Ele vive em `fdp_epi_movements.status` — a linha que registra a
 * movimentação —, e nunca no catálogo. O catálogo descreve o modelo do
 * equipamento, e um modelo não é "entregue" nem "extraviado": uma peça dele é.
 * O CHECK do catálogo aceitava os dois vocabulários misturados até a migration
 * 0062, e um vocabulário que o banco aceita e ninguém usa é convite documentado
 * ao erro (§52).
 */
export const epiUnitStatuses = [
  "in_stock", "delivered", "returned", "sanitizing", "discarded", "damaged", "lost",
] as const;
export type EpiUnitStatus = typeof epiUnitStatuses[number];

/** Estado do **catálogo**: o modelo está disponível para uso ou não. */
export const epiCatalogStatuses = ["active", "inactive"] as const;
export type EpiCatalogStatus = typeof epiCatalogStatuses[number];

export const epiProductStatuses = [...epiCatalogStatuses, ...epiUnitStatuses] as const;
export type EpiProductStatus = typeof epiProductStatuses[number];

export const epiProductStatusLabels: Record<EpiProductStatus, string> = {
  active: "Ativo",
  inactive: "Inativo",
  in_stock: "Em estoque",
  delivered: "Entregue",
  returned: "Devolvido",
  sanitizing: "Em higienização",
  discarded: "Descartado",
  damaged: "Danificado",
  lost: "Extraviado",
};

export const epiRegistrationReasons = [
  "first_delivery", "periodic_exchange", "damage_replacement", "loss_replacement",
  "expiry_replacement", "initial_purchase", "stock_replenishment", "manual_adjustment", "other",
] as const;
export type EpiRegistrationReason = typeof epiRegistrationReasons[number];

export const epiRegistrationReasonLabels: Record<EpiRegistrationReason, string> = {
  first_delivery: "Primeira entrega",
  periodic_exchange: "Troca periódica",
  damage_replacement: "Substituição por dano",
  loss_replacement: "Substituição por extravio",
  expiry_replacement: "Substituição por vencimento",
  initial_purchase: "Compra inicial",
  stock_replenishment: "Reposição de estoque",
  manual_adjustment: "Ajuste manual",
  other: "Outro",
};

export const epiDeliveryStatuses = ["delivered", "pending_signature", "signed", "canceled"] as const;
export type EpiDeliveryStatus = typeof epiDeliveryStatuses[number];

export const epiDeliveryStatusLabels: Record<EpiDeliveryStatus, string> = {
  delivered: "Entregue",
  pending_signature: "Pendente assinatura",
  signed: "Assinado",
  canceled: "Cancelado",
};

export const epiDamageReasons = [
  "natural_wear", "work_accident", "misuse", "bad_storage", "protection_loss",
  "torn_broken", "contaminated", "soaked", "other",
] as const;
export type EpiDamageReason = typeof epiDamageReasons[number];

export const epiDamageReasonLabels: Record<EpiDamageReason, string> = {
  natural_wear: "Desgaste natural",
  work_accident: "Acidente de trabalho",
  misuse: "Uso inadequado",
  bad_storage: "Mau armazenamento",
  protection_loss: "Perda de característica de proteção",
  torn_broken: "Rasgado ou quebrado",
  contaminated: "Contaminado",
  soaked: "Molhado ou inutilizado",
  other: "Outro",
};

export const epiDamageDecisions = [
  "exchange_without_discount", "send_to_discount_analysis", "refuse_exchange",
  "send_to_disposal", "send_to_sanitizing",
] as const;
export type EpiDamageDecision = typeof epiDamageDecisions[number];

export const epiDamageDecisionLabels: Record<EpiDamageDecision, string> = {
  exchange_without_discount: "Troca sem desconto",
  send_to_discount_analysis: "Enviar para análise de desconto",
  refuse_exchange: "Recusar troca",
  send_to_disposal: "Encaminhar para descarte",
  send_to_sanitizing: "Encaminhar para higienização",
};

export const epiReturnConditions = [
  "returned_sanitized", "returned_pending_sanitizing", "returned_damaged",
  "returned_unusable", "returned_for_disposal", "not_returned", "lost",
] as const;
export type EpiReturnCondition = typeof epiReturnConditions[number];

export const epiReturnConditionLabels: Record<EpiReturnCondition, string> = {
  returned_sanitized: "Devolvido higienizado",
  returned_pending_sanitizing: "Devolvido pendente de higienização",
  returned_damaged: "Devolvido danificado",
  returned_unusable: "Devolvido inutilizado",
  returned_for_disposal: "Devolvido para descarte",
  not_returned: "Não devolvido",
  lost: "Extraviado",
};

export const epiDisposalReasons = [
  "damage", "contamination", "natural_wear", "expired", "inadequate",
  "unusable_return", "mandatory_exchange", "other",
] as const;
export type EpiDisposalReason = typeof epiDisposalReasons[number];

export const epiDisposalReasonLabels: Record<EpiDisposalReason, string> = {
  damage: "Danificação",
  contamination: "Contaminação",
  natural_wear: "Desgaste natural",
  expired: "Validade vencida",
  inadequate: "CA ou produto inadequado para uso",
  unusable_return: "Devolução sem condição de reaproveitamento",
  mandatory_exchange: "Troca obrigatória",
  other: "Outro",
};

export const epiDisposalStatuses = ["awaiting_disposal", "disposed", "canceled", "reevaluated"] as const;
export type EpiDisposalStatus = typeof epiDisposalStatuses[number];

export const epiDisposalStatusLabels: Record<EpiDisposalStatus, string> = {
  awaiting_disposal: "Aguardando descarte",
  disposed: "Descartado",
  canceled: "Cancelado",
  reevaluated: "Reavaliado",
};

export const epiDiscountTriggers = [
  "lost", "not_returned", "misuse_damage", "refused_return",
  "manual_request", "delivery_return_divergence",
] as const;
export type EpiDiscountTrigger = typeof epiDiscountTriggers[number];

export const epiDiscountTriggerLabels: Record<EpiDiscountTrigger, string> = {
  lost: "EPI extraviado",
  not_returned: "EPI não devolvido",
  misuse_damage: "EPI danificado por uso inadequado",
  refused_return: "Devolução recusada",
  manual_request: "Solicitação manual de desconto",
  delivery_return_divergence: "Divergência entre entrega e devolução",
};

export const epiDiscountStatuses = [
  "awaiting_dp_analysis", "awaiting_approval", "approved_for_discount",
  "refused", "canceled", "finished",
] as const;
export type EpiDiscountStatus = typeof epiDiscountStatuses[number];

export const epiDiscountStatusLabels: Record<EpiDiscountStatus, string> = {
  awaiting_dp_analysis: "Aguardando análise DP",
  awaiting_approval: "Aguardando aprovação",
  approved_for_discount: "Aprovado para desconto",
  refused: "Recusado",
  canceled: "Cancelado",
  finished: "Finalizado",
};

export const epiDiscountDecisions = [
  "no_discount", "full_discount", "partial_discount",
  "request_more_info", "forward_to_payroll", "close_without_action",
] as const;
export type EpiDiscountDecision = typeof epiDiscountDecisions[number];

export const epiDiscountDecisionLabels: Record<EpiDiscountDecision, string> = {
  no_discount: "Não descontar",
  full_discount: "Descontar integral",
  partial_discount: "Descontar parcial",
  request_more_info: "Solicitar mais informações",
  forward_to_payroll: "Encaminhar para financeiro/folha",
  close_without_action: "Encerrar sem ação",
};

export const epiMovementTypes = [
  "registration", "stock_entry", "stock_transfer", "delivery", "exchange", "return",
  "sanitizing", "sanitization_completed", "disposal", "discount_analysis", "manual_adjustment",
] as const;
export type EpiMovementType = typeof epiMovementTypes[number];

export const epiMovementTypeLabels: Record<EpiMovementType, string> = {
  registration: "Cadastro",
  stock_entry: "Entrada de estoque",
  stock_transfer: "Transferência entre locais",
  delivery: "Entrega",
  exchange: "Troca",
  return: "Devolução",
  sanitizing: "Higienização",
  sanitization_completed: "Higienização concluída",
  disposal: "Descarte",
  discount_analysis: "Análise de desconto",
  manual_adjustment: "Ajuste manual",
};

export const epiAttachmentEntities = ["product", "delivery", "return", "damage", "disposal", "discount"] as const;
export type EpiAttachmentEntity = typeof epiAttachmentEntities[number];

export const epiAttachmentKinds = ["evidence", "delivery_term", "photo", "document"] as const;
export type EpiAttachmentKind = typeof epiAttachmentKinds[number];

export const epiAttachmentKindLabels: Record<EpiAttachmentKind, string> = {
  evidence: "Evidência",
  delivery_term: "Termo de entrega",
  photo: "Foto",
  document: "Documento",
};

/** Estados que a janela de descarte recolhe do estoque, sem intervenção manual. */
export const epiDisposableStatuses: readonly EpiProductStatus[] = ["damaged", "lost", "sanitizing", "discarded"];

/**
 * Destino do EPI a partir da condição informada na devolução.
 *
 * A decisão é da condição, não de quem digita. Deixar as três caixas de seleção
 * — volta ao estoque, precisa higienizar, vai para descarte — livres permitiria
 * gravar "extraviado" e "volta ao estoque" na mesma linha, e o estoque passaria
 * a contar equipamento que ninguém tem.
 */
export function returnRouting(condition: EpiReturnCondition): {
  backToStock: boolean;
  needsSanitizing: boolean;
  sendToDisposal: boolean;
  generateDpDemand: boolean;
  productStatus: EpiUnitStatus;
  disposalReason: EpiDisposalReason | null;
  discountTrigger: EpiDiscountTrigger | null;
} {
  switch (condition) {
    case "returned_sanitized":
      return { backToStock: true, needsSanitizing: false, sendToDisposal: false, generateDpDemand: false, productStatus: "in_stock", disposalReason: null, discountTrigger: null };
    case "returned_pending_sanitizing":
      return { backToStock: false, needsSanitizing: true, sendToDisposal: false, generateDpDemand: false, productStatus: "sanitizing", disposalReason: null, discountTrigger: null };
    case "returned_damaged":
      return { backToStock: false, needsSanitizing: false, sendToDisposal: true, generateDpDemand: false, productStatus: "damaged", disposalReason: "damage", discountTrigger: null };
    case "returned_unusable":
      return { backToStock: false, needsSanitizing: false, sendToDisposal: true, generateDpDemand: false, productStatus: "damaged", disposalReason: "unusable_return", discountTrigger: null };
    case "returned_for_disposal":
      return { backToStock: false, needsSanitizing: false, sendToDisposal: true, generateDpDemand: false, productStatus: "damaged", disposalReason: "mandatory_exchange", discountTrigger: null };
    case "not_returned":
      return { backToStock: false, needsSanitizing: false, sendToDisposal: false, generateDpDemand: true, productStatus: "lost", disposalReason: null, discountTrigger: "not_returned" };
    case "lost":
      return { backToStock: false, needsSanitizing: false, sendToDisposal: false, generateDpDemand: true, productStatus: "lost", disposalReason: null, discountTrigger: "lost" };
  }
}

/**
 * O que a decisão da análise de dano provoca.
 *
 * `settleOldDelivery` é a baixa do equipamento antigo na entrega original: sem
 * ela, o colaborador continuaria constando com um EPI que já não existe, e o
 * relatório de "EPIs ativos com o colaborador" mentiria.
 */
export function damageRouting(decision: EpiDamageDecision): {
  settleOldDelivery: boolean;
  createDisposal: boolean;
  disposalReason: EpiDisposalReason | null;
  deliverReplacement: boolean;
  productStatus: EpiProductStatus;
  discountTrigger: EpiDiscountTrigger | null;
} {
  switch (decision) {
    case "exchange_without_discount":
      return { settleOldDelivery: true, createDisposal: true, disposalReason: "damage", deliverReplacement: true, productStatus: "damaged", discountTrigger: null };
    case "send_to_discount_analysis":
      return { settleOldDelivery: true, createDisposal: false, disposalReason: null, deliverReplacement: true, productStatus: "damaged", discountTrigger: "misuse_damage" };
    case "refuse_exchange":
      // A recusa não abre demanda sozinha: recusar a troca é decidir sobre o
      // equipamento, não sobre o salário. Quem quiser levar o caso ao DP abre a
      // análise explicitamente, e o registro da recusa fica como evidência.
      return { settleOldDelivery: false, createDisposal: false, disposalReason: null, deliverReplacement: false, productStatus: "damaged", discountTrigger: null };
    case "send_to_disposal":
      return { settleOldDelivery: true, createDisposal: true, disposalReason: "damage", deliverReplacement: false, productStatus: "damaged", discountTrigger: null };
    case "send_to_sanitizing":
      return { settleOldDelivery: true, createDisposal: false, disposalReason: null, deliverReplacement: false, productStatus: "sanitizing", discountTrigger: null };
  }
}

/**
 * Descarte que sai do estoque é só o que estava no estoque.
 *
 * Um EPI que veio de devolução ou de troca já saiu do estoque na entrega.
 * Descontá-lo de novo na confirmação do descarte tiraria duas unidades por uma.
 */
export function disposalTouchesStock(originType: "manual" | "return" | "damage") {
  return originType === "manual";
}

/** Título da demanda aberta para o DP. O formato é contrato com a §7. */
export function discountTitle(employeeName: string) {
  return `Analisar possível desconto de EPI — ${employeeName.trim() || "colaborador não identificado"}`;
}

/** Valor total em análise. Arredonda em centavos para não acumular dízima. */
export function discountTotal(unitValue: number, quantity: number) {
  return Math.round(Math.max(unitValue, 0) * Math.max(quantity, 0) * 100) / 100;
}

/**
 * O valor decidido cabe na decisão tomada.
 *
 * "Aprovado para desconto" com valor zero é aprovação de nada, e "não
 * descontar" com valor é a contradição que a folha executaria sem perguntar.
 */
export function decidedValueFor(decision: EpiDiscountDecision, requested: number, total: number) {
  if (decision === "full_discount") return total;
  if (decision === "partial_discount") return Math.min(Math.max(Math.round(requested * 100) / 100, 0), total);
  return 0;
}

/** Estado final da análise, dado o parecer. */
export function discountStatusFor(decision: EpiDiscountDecision): EpiDiscountStatus {
  switch (decision) {
    case "full_discount":
    case "partial_discount":
      return "approved_for_discount";
    case "no_discount":
      return "refused";
    case "request_more_info":
      return "awaiting_dp_analysis";
    case "forward_to_payroll":
      return "awaiting_approval";
    case "close_without_action":
      return "finished";
  }
}

/** Dias que faltam para o CA vencer. Negativo significa vencido. */
export function daysUntil(reference: string, today: string) {
  const target = Date.parse(`${reference}T12:00:00Z`);
  const base = Date.parse(`${today}T12:00:00Z`);
  if (Number.isNaN(target) || Number.isNaN(base)) return null;
  return Math.round((target - base) / 86_400_000);
}

/** Janela em que o CA já exige providência: vencido ou a menos de 60 dias. */
export const caExpiryWindowDays = 60;

export function caExpiryTone(caExpiresOn: string | null, today: string): "expired" | "expiring" | "valid" | "unknown" {
  if (!caExpiresOn) return "unknown";
  const remaining = daysUntil(caExpiresOn, today);
  if (remaining === null) return "unknown";
  if (remaining < 0) return "expired";
  return remaining <= caExpiryWindowDays ? "expiring" : "valid";
}
