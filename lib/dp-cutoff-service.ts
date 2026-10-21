/**
 * DP Operacional, Fase 3 — corte e ocorrência no mesmo lote da demanda.
 *
 * A regra está em `lib/dp-cutoff.ts`. Aqui: ler as regras do workspace e
 * devolver os statements que gravam o veredito na demanda e, fora do corte, a
 * ocorrência automática. Entram no lote de criação, depois do INSERT da
 * demanda: demanda, veredito e ocorrência nascem juntos.
 */
import type { getD1 } from "../db/index.ts";
import { todayInBrazil } from "./employee-history.ts";
import { loadBusinessCalendar } from "./dp-recurring-service.ts";
import { cutoffNotice, evaluateCutoff, ruleFor, ruleFromRow, type CutoffRule, type CutoffVerdict } from "./dp-cutoff.ts";
import { dayLabel, monthDay } from "./dp-calendar.ts";

type Database = ReturnType<typeof getD1>;

export async function loadCutoffRules(d1: Database, workspaceId: string): Promise<CutoffRule[]> {
  const rows = await d1.prepare(`SELECT code, name, process_types, kind, value, month_day_limit, description, status
    FROM fdp_cutoff_rules WHERE workspace_id = ? ORDER BY name`).bind(workspaceId).all<Record<string, unknown>>();
  return rows.results.map(ruleFromRow);
}

/** Nome da área que pediu: o rótulo informado, ou o nome da área cadastrada. */
export async function requesterAreaLabel(d1: Database, workspaceId: string, areaId: string | null, label: string) {
  if (label.trim()) return label.trim().slice(0, 120);
  if (!areaId) return "";
  const area = await d1.prepare("SELECT name FROM fdp_areas WHERE workspace_id = ? AND id = ?").bind(workspaceId, areaId).first<{ name: string }>();
  return String(area?.name ?? "").slice(0, 120);
}

export type CutoffEvaluation = {
  statements: D1PreparedStatement[];
  rule: CutoffRule | null;
  verdict: CutoffVerdict | null;
  /** Aviso ao solicitante; vazio dentro do corte ou sem regra. */
  notice: string;
};

export async function prepareCutoffEvaluation(d1: Database, input: {
  workspaceId: string;
  cardId: string;
  processType: string;
  companyId: string | null;
  competence: string | null;
  requestedFor: string | null;
  areaLabel: string;
  createdOn?: string;
  actor: string;
  title: string;
}): Promise<CutoffEvaluation> {
  const createdOn = input.createdOn ?? todayInBrazil();
  const [rules, calendar] = await Promise.all([loadCutoffRules(d1, input.workspaceId), loadBusinessCalendar(d1, input.workspaceId)]);
  const rule = ruleFor(rules, input.processType);
  const verdict = rule ? evaluateCutoff(rule, { createdOn, requestedFor: input.requestedFor, competence: input.competence }, calendar) : null;
  const statements: D1PreparedStatement[] = [
    d1.prepare(`UPDATE fdp_cards SET within_cutoff = ?, requested_for = ?::date, requester_area_label = ?, cutoff_rule_code = ?
      WHERE workspace_id = ? AND id = ?`)
      .bind(verdict?.within ?? null, input.requestedFor, input.areaLabel.slice(0, 120), rule?.code ?? "", input.workspaceId, input.cardId),
  ];
  if (rule && verdict?.within === false) {
    statements.push(d1.prepare(`INSERT INTO fdp_dp_occurrences
      (id, workspace_id, occurred_on, area, company_id, card_id, fact, impact, origin, days_late, registered_by)
      VALUES (?, ?, ?::date, ?, ?, ?, ?, ?, 'automatica', ?, ?)
      ON CONFLICT (workspace_id, card_id) WHERE origin = 'automatica' AND card_id IS NOT NULL DO NOTHING`)
      .bind(crypto.randomUUID(), input.workspaceId, createdOn, input.areaLabel.slice(0, 120), input.companyId, input.cardId,
        `${rule.name}: "${input.title.slice(0, 200)}" chegou fora do corte. ${verdict.reason}`.slice(0, 1000),
        "Entra no próximo ciclo ou depende de aprovação da gestão.", verdict.daysLate, input.actor));
  }
  return { statements, rule, verdict, notice: rule && verdict ? cutoffNotice(verdict, rule) : "" };
}

/**
 * Lançamento de variáveis depois do corte (regra do processo "VARIÁVEIS", dia
 * 26 por padrão): uma ocorrência automática por lote lançado fora do prazo.
 */
export async function prepareLateMovementOccurrence(d1: Database, input: {
  workspaceId: string; companyId: string; competence: string; rows: number; areaLabel: string; actor: string; createdOn?: string;
}) {
  const createdOn = input.createdOn ?? todayInBrazil();
  const rules = await loadCutoffRules(d1, input.workspaceId);
  const rule = ruleFor(rules, "VARIÁVEIS");
  const limitDay = rule?.kind === "dia_do_mes" ? rule.value : 26;
  const deadline = monthDay(input.competence, limitDay);
  if (createdOn <= deadline) return [];
  const daysLate = Math.round((new Date(`${createdOn}T12:00:00Z`).getTime() - new Date(`${deadline}T12:00:00Z`).getTime()) / 86_400_000);
  return [d1.prepare(`INSERT INTO fdp_dp_occurrences
    (id, workspace_id, occurred_on, area, company_id, card_id, fact, impact, origin, days_late, registered_by)
    VALUES (?, ?, ?::date, ?, ?, NULL, ?, ?, 'automatica', ?, ?)`)
    .bind(crypto.randomUUID(), input.workspaceId, createdOn, input.areaLabel.slice(0, 120), input.companyId,
      `${input.rows} lançamento(s) de variáveis da competência ${input.competence.slice(5, 7)}/${input.competence.slice(0, 4)} depois do corte de ${dayLabel(deadline)}.`,
      "Conferência e exportação fora do calendário da folha.", daysLate, input.actor)];
}
