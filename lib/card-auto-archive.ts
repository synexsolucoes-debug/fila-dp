/**
 * Demandas concluídas saem do quadro sozinhas.
 *
 * A coluna "Concluído" crescia para sempre. O quadro é lido o dia inteiro, e
 * uma coluna com centenas de cartões terminados empurra o que ainda está em
 * curso para fora da tela, além de pesar no carregamento.
 *
 * A regra: a demanda concluída ou cancelada há mais de N dias vai para o
 * Arquivo. N é do grupo (`fdp_workspace_settings.completed_archive_days`),
 * 7 por padrão, e 0 desliga. Nada é apagado: o Arquivo restaura a demanda com
 * histórico, anexos e checklist.
 *
 * Demanda restaurada do Arquivo não volta para ele sozinha: a restauração
 * mantém `archived_at`, e a regra só pega quem nunca foi arquivado. Se alguém
 * restaurou, quer a demanda à vista. Movê-la de coluna limpa a marca, e a
 * regra volta a valer quando ela for concluída de novo.
 *
 * Roda ao carregar o quadro, e não num agendamento: quem não abre o quadro
 * não sente a coluna cheia, e quem abre recebe o quadro já arrumado, sem
 * depender de um cron que pode estar parado.
 */
import type { getD1 } from "../db";

type Database = ReturnType<typeof getD1>;

export const DEFAULT_COMPLETED_ARCHIVE_DAYS = 7;
export const MAX_COMPLETED_ARCHIVE_DAYS = 365;

/** Dias válidos para a regra: inteiro de 0 (nunca) a 365. Fora disso, o padrão. */
export function normalizeCompletedArchiveDays(value: unknown): number {
  // Sem valor gravado vale o padrão, e não zero: `Number("")` é 0, e 0 desliga a regra.
  if (value === null || value === undefined || String(value).trim() === "") return DEFAULT_COMPLETED_ARCHIVE_DAYS;
  const days = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(days) || days < 0) return DEFAULT_COMPLETED_ARCHIVE_DAYS;
  return Math.min(MAX_COMPLETED_ARCHIVE_DAYS, Math.floor(days));
}

/**
 * Quando a demanda terminou. `closed_at` é gravado ao mover para a coluna de
 * concluídas e ao cancelar. Sem ele, vale a última alteração da demanda que
 * está concluída de outro jeito: `sla_status = 'completed'` (as antigas, de
 * antes do campo) ou parada numa coluna do tipo Concluído. Há quadros em que
 * a coluna "Concluído" nasceu com o tipo certo (`kind = 'done'`) e o SLA ainda
 * "em andamento"; nelas a demanda nunca ganha `closed_at`, e sem esta segunda
 * via a coluna continuaria enchendo para sempre.
 */
export const FINISHED_AT_SQL = "COALESCE(closed_at, CASE WHEN sla_status = 'completed' OR list_id IN (SELECT id FROM fdp_lists WHERE kind = 'done' OR sla_behavior = 'completed') THEN updated_at END)";

/**
 * Arquiva as demandas do grupo que terminaram há mais de `days` dias e
 * devolve quantas saíram do quadro.
 */
export async function archiveFinishedCards(d1: Database, workspaceId: string, days: number): Promise<number> {
  if (!Number.isInteger(days) || days <= 0) return 0;
  const result = await d1.prepare(`UPDATE fdp_cards
      SET archived = 1, archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE workspace_id = ? AND archived = 0 AND archived_at IS NULL
      AND ${FINISHED_AT_SQL} IS NOT NULL
      AND ${FINISHED_AT_SQL} < CURRENT_TIMESTAMP - make_interval(days => ?)`)
    .bind(workspaceId, days).run();
  return Number((result as { meta?: { changes?: number } })?.meta?.changes ?? 0);
}
