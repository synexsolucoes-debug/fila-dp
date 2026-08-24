/**
 * Sugestões de movimentação: o passo que impede a automação do Teams de abrir
 * demanda errada.
 *
 * Quando a interpretação reconhece a movimentação mas não reúne os dados
 * obrigatórios — falta o colaborador, o valor ou a vigência —, o sistema não
 * inventa o que falta nem descarta a informação. Ele grava uma sugestão, e
 * alguém do DP confirma, completa ou rejeita.
 *
 * A confirmação aceita correções: quem revisa normalmente está olhando a
 * mensagem original ao lado e sabe o dado que faltou.
 */
import { ApiError } from "./api-errors.ts";
import { cleanText } from "./clean-text.ts";
import { optionalDate } from "./registrations.ts";
import { MOVEMENT_PROCESS_TYPE, type MovementKind } from "./teams-movements.ts";

export type SuggestionRow = {
  id: string;
  workspace_id: string;
  integration_id: string;
  movement_kind: MovementKind;
  status: string;
  confidence: number;
  employee_name: string;
  employee_id: string | null;
  previous_salary_cents: number | null;
  new_salary_cents: number | null;
  previous_role: string;
  new_role: string;
  effective_date: string | null;
  requested_by_name: string;
  team_name: string;
  channel_name: string;
  message_id: string;
  message_url: string;
  original_message: string;
  missing_fields_json: unknown;
  signals_json: unknown;
  card_id: string | null;
  created_at: string;
};

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
    } catch { return []; }
  }
  return [];
}

function reais(cents: number | null) {
  return cents === null ? null : Math.round(cents) / 100;
}

/** Formato da sugestão para a tela de validação. */
export function presentSuggestion(row: SuggestionRow) {
  return {
    id: row.id,
    integrationId: row.integration_id,
    kind: row.movement_kind,
    kindLabel: row.movement_kind === "salary_change" ? "Alteração salarial" : "Alteração de cargo/função",
    status: row.status,
    confidence: row.confidence,
    employeeName: row.employee_name,
    employeeId: row.employee_id,
    previousSalary: reais(row.previous_salary_cents),
    newSalary: reais(row.new_salary_cents),
    previousRole: row.previous_role,
    newRole: row.new_role,
    effectiveDate: row.effective_date,
    requestedBy: row.requested_by_name,
    team: row.team_name,
    channel: row.channel_name,
    messageUrl: row.message_url,
    originalMessage: row.original_message,
    missing: asArray(row.missing_fields_json),
    signals: asArray(row.signals_json),
    cardId: row.card_id,
    createdAt: row.created_at,
  };
}

export type SuggestionCorrections = {
  employeeName: string;
  employeeId: string | null;
  newSalary: number | null;
  previousSalary: number | null;
  newRole: string;
  previousRole: string;
  effectiveDate: string | null;
};

/**
 * Aplica as correções do revisor sobre o que foi interpretado.
 *
 * O valor informado por quem revisa sempre vence o interpretado: a revisão só
 * tem sentido se conseguir corrigir uma leitura errada — não apenas preencher
 * lacuna.
 */
export function applyCorrections(row: SuggestionRow, body: Record<string, unknown>): SuggestionCorrections {
  const money = (value: unknown, fallback: number | null) => {
    if (value === undefined || value === null || value === "") return fallback;
    const parsed = typeof value === "number" ? value : Number(String(value).replace(/\./gu, "").replace(",", "."));
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100_000_000) {
      throw ApiError.badRequest("Informe um valor de salário válido.", "MOVEMENT_SALARY_INVALID");
    }
    return Math.round(parsed * 100) / 100;
  };

  const effectiveDate = body.effectiveDate === undefined
    ? row.effective_date
    : optionalDate(body.effectiveDate);

  return {
    employeeName: cleanText(body.employeeName, 160) || row.employee_name,
    employeeId: body.employeeId === undefined ? row.employee_id : (cleanText(body.employeeId, 120) || null),
    newSalary: money(body.newSalary, reais(row.new_salary_cents)),
    previousSalary: money(body.previousSalary, reais(row.previous_salary_cents)),
    newRole: cleanText(body.newRole, 120) || row.new_role,
    previousRole: cleanText(body.previousRole, 120) || row.previous_role,
    effectiveDate,
  };
}

/**
 * O que ainda falta para a sugestão poder virar demanda.
 *
 * Confirmar sem os dados obrigatórios só empurraria o cartão incompleto para o
 * fluxo do DP — exatamente o que a sugestão existe para evitar.
 */
export function remainingGaps(kind: MovementKind, corrections: SuggestionCorrections) {
  const missing: string[] = [];
  if (!corrections.employeeName) missing.push("colaborador");
  if (!corrections.effectiveDate) missing.push("data de vigência");
  if (kind === "salary_change" && corrections.newSalary === null) missing.push("novo salário");
  if (kind === "role_change" && !corrections.newRole) missing.push("novo cargo");
  return missing;
}

export function assertComplete(kind: MovementKind, corrections: SuggestionCorrections) {
  const missing = remainingGaps(kind, corrections);
  if (missing.length) {
    throw ApiError.badRequest(
      `Para transformar em demanda, informe: ${missing.join(", ")}.`,
      "MOVEMENT_SUGGESTION_INCOMPLETE",
    );
  }
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

function brazilianDate(iso: string | null) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/u.test(iso)) return "não informada";
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

/** Demanda gerada a partir da sugestão confirmada, já com as correções. */
export function confirmedTaskDraft(row: SuggestionRow, corrections: SuggestionCorrections, confirmedByEmail: string) {
  const kind = row.movement_kind;
  const shared = [
    `Origem: Microsoft Teams · ${row.team_name || "equipe não informada"} › ${row.channel_name || "canal não informado"}`,
    `Solicitante: ${row.requested_by_name || "não identificado"}`,
    `Vigência: ${brazilianDate(corrections.effectiveDate)}`,
    row.message_url ? `Mensagem: ${row.message_url}` : "",
    `Sugestão validada por ${confirmedByEmail} (confiança da leitura automática: ${row.confidence}%).`,
    "",
    "Mensagem original:",
    row.original_message.slice(0, 1500),
  ].filter(Boolean);

  if (kind === "salary_change") {
    return {
      processType: MOVEMENT_PROCESS_TYPE.salary_change,
      title: `Alteração salarial — ${corrections.employeeName}`.slice(0, 160),
      description: [
        `Alteração salarial confirmada para ${corrections.employeeName}.`,
        `Salário anterior: ${corrections.previousSalary === null ? "não informado" : BRL.format(corrections.previousSalary)} · `
        + `Novo salário: ${corrections.newSalary === null ? "não informado" : BRL.format(corrections.newSalary)}`,
        ...shared,
      ].join("\n").slice(0, 4000),
      checklist: [
        "Validar o novo salário contra a faixa do cargo e o acordo coletivo",
        "Confirmar a data de vigência com a folha",
        "Registrar a alteração salarial no ERP/folha",
        "Atualizar o cadastro do colaborador no Vinculato",
        "Comunicar o colaborador e arquivar o comprovante",
      ],
    };
  }

  return {
    processType: MOVEMENT_PROCESS_TYPE.role_change,
    title: `Alteração de cargo/função — ${corrections.employeeName}`.slice(0, 160),
    description: [
      `Alteração de cargo/função confirmada para ${corrections.employeeName}.`,
      `Cargo atual: ${corrections.previousRole || "não informado"} · Novo cargo: ${corrections.newRole}`,
      ...shared,
    ].join("\n").slice(0, 4000),
    checklist: [
      "Validar o novo cargo no plano de cargos e salários",
      "Verificar se há alteração salarial vinculada à mudança de função",
      "Confirmar a data de vigência com a folha",
      "Registrar a alteração de cargo no ERP/folha",
      "Atualizar o cadastro do colaborador no Vinculato",
      "Comunicar o colaborador e arquivar o comprovante",
    ],
  };
}
