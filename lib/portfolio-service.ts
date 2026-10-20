/**
 * Carteira do DP — troca de titular e repasse ao backup.
 *
 * A regra está em `lib/portfolio.ts`; a atribuição na criação da demanda, em
 * `lib/portfolio-assignment.ts`.
 */
import type { getD1 } from "../db/index.ts";
import { ApiError } from "./api-errors.ts";
import { prepareAuditEvent } from "./fila-dp-db.ts";
import { closingDateFor, validatePortfolioChange, type PortfolioChangeInput } from "./portfolio.ts";
import { OPEN_CARD_CONDITION, prepareAssigneeStatements, termFromRow } from "./portfolio-assignment.ts";

export { OPEN_CARD_CONDITION, preparePortfolioAssignment, responsavelPara } from "./portfolio-assignment.ts";

type Database = ReturnType<typeof getD1>;
type Row = Record<string, unknown>;

/**
 * Troca o responsável de demandas em aberto: sai `fromUserId`, entra `toUserId`.
 *
 * Só a pessoa que sai é trocada — outros responsáveis da mesma demanda ficam.
 * O nome exibido passa a ser o de quem entra.
 */
function prepareReassignStatements(d1: Database, workspaceId: string, cardIds: readonly string[], fromUserId: string, toUserId: string) {
  return cardIds.flatMap((cardId) => [
    d1.prepare("DELETE FROM fdp_card_assignees WHERE workspace_id = ? AND card_id = ? AND user_id = ?").bind(workspaceId, cardId, fromUserId),
    ...prepareAssigneeStatements(d1, workspaceId, cardId, toUserId),
  ]);
}

async function openCardsOf(d1: Database, workspaceId: string, userId: string, companyIds: readonly string[]) {
  if (!companyIds.length) return [];
  const rows = await d1.prepare(`SELECT c.id FROM fdp_cards c
    JOIN fdp_card_assignees ca ON ca.workspace_id = c.workspace_id AND ca.card_id = c.id AND ca.user_id = ?
    WHERE c.workspace_id = ? AND c.company_id IN (${companyIds.map(() => "?").join(",")}) AND ${OPEN_CARD_CONDITION}`)
    .bind(userId, workspaceId, ...companyIds).all<Row>();
  return rows.results.map((row) => String(row.id));
}

async function requireActiveMembers(d1: Database, workspaceId: string, userIds: readonly string[]) {
  const ids = [...new Set(userIds)];
  const rows = await d1.prepare(`SELECT user_id FROM fdp_workspace_members
    WHERE workspace_id = ? AND user_id IN (${ids.map(() => "?").join(",")}) AND role IN ('admin', 'member')`)
    .bind(workspaceId, ...ids).all<Row>();
  if (rows.results.length !== ids.length) {
    throw ApiError.badRequest("Titular e backup precisam ser membros ativos do grupo.", "PORTFOLIO_MEMBER_INVALID");
  }
}

type Actor = { userId: string; email: string; requestId?: string | null };

/**
 * Troca a carteira de uma empresa a partir de uma data.
 *
 * Encerra a vigência aberta (não apaga), abre a nova e passa para o novo
 * titular as demandas em aberto que estavam com o titular que sai. Demandas
 * concluídas continuam com quem as concluiu.
 */
export async function transferPortfolio(d1: Database, workspaceId: string, actor: Actor, input: Partial<PortfolioChangeInput>) {
  const problem = validatePortfolioChange(input);
  if (problem) throw ApiError.badRequest(problem, "PORTFOLIO_INVALID");
  const change = input as PortfolioChangeInput;
  const company = await d1.prepare("SELECT id FROM fdp_companies WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, change.companyId).first<Row>();
  if (!company) throw ApiError.notFound("Empresa não encontrada.", "PORTFOLIO_COMPANY_NOT_FOUND");
  await requireActiveMembers(d1, workspaceId, [change.holderUserId, ...(change.backupUserId ? [change.backupUserId] : [])]);

  const open = await d1.prepare(`SELECT id, company_id, holder_user_id, backup_user_id, valid_from::text AS valid_from, valid_to::text AS valid_to
    FROM fdp_company_portfolio WHERE workspace_id = ? AND company_id = ? AND valid_to IS NULL`)
    .bind(workspaceId, change.companyId).first<Row>();
  const before = open ? termFromRow(open) : null;
  if (before && before.holderUserId === change.holderUserId && before.backupUserId === change.backupUserId) {
    return { changed: false, reassigned: 0 };
  }

  const statements: D1PreparedStatement[] = [];
  if (open && before) {
    const closing = closingDateFor(before.validFrom, change.validFrom);
    if (!closing) {
      throw ApiError.badRequest(`A vigência atual começou em ${before.validFrom}; a troca precisa começar nessa data ou depois.`, "PORTFOLIO_DATE_BEFORE_CURRENT");
    }
    statements.push(d1.prepare(`UPDATE fdp_company_portfolio SET valid_to = ?::date, ended_by = ?, ended_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND id = ? AND valid_to IS NULL`).bind(closing, actor.userId, workspaceId, String(open.id)));
  }
  const termId = crypto.randomUUID();
  statements.push(d1.prepare(`INSERT INTO fdp_company_portfolio (id, workspace_id, company_id, holder_user_id, backup_user_id, valid_from, created_by)
    VALUES (?, ?, ?, ?, ?, ?::date, ?)`)
    .bind(termId, workspaceId, change.companyId, change.holderUserId, change.backupUserId, change.validFrom, actor.userId));

  const moving = before && before.holderUserId !== change.holderUserId
    ? await openCardsOf(d1, workspaceId, before.holderUserId, [change.companyId])
    : [];
  if (before && moving.length) statements.push(...prepareReassignStatements(d1, workspaceId, moving, before.holderUserId, change.holderUserId));

  statements.push(prepareAuditEvent({
    workspaceId, actorUserId: actor.userId, actorEmail: actor.email,
    action: before ? "portfolio.transferred" : "portfolio.assigned",
    entityType: "company_portfolio", entityId: termId,
    before: before ? { holderUserId: before.holderUserId, backupUserId: before.backupUserId, validFrom: before.validFrom } : null,
    after: { holderUserId: change.holderUserId, backupUserId: change.backupUserId, validFrom: change.validFrom },
    metadata: { scope: "company", companyId: change.companyId, reassignedCards: moving.length },
    requestId: actor.requestId ?? null,
  }));
  await d1.batch(statements);
  return { changed: true, reassigned: moving.length };
}

/**
 * "Passar minhas abertas para o backup" — o botão da ausência.
 *
 * Para cada empresa em que a pessoa é titular vigente e há backup, as demandas
 * em aberto dela naquela empresa vão para o backup. Empresa sem backup fica
 * como está e volta na resposta, para a tela dizer o que não foi possível.
 * `allowedCompanyIds` recorta pelo acesso por empresa de quem clica (`null` =
 * sem restrição).
 */
export async function handOverToBackup(d1: Database, workspaceId: string, actor: Actor, userId: string, allowedCompanyIds: ReadonlySet<string> | null = null) {
  const terms = await d1.prepare(`SELECT company_id, backup_user_id FROM fdp_company_portfolio
    WHERE workspace_id = ? AND holder_user_id = ? AND valid_to IS NULL ORDER BY company_id`).bind(workspaceId, userId).all<Row>();
  const statements: D1PreparedStatement[] = [];
  const moved: Array<{ companyId: string; backupUserId: string; cards: number }> = [];
  const withoutBackup: string[] = [];
  for (const term of terms.results) {
    const companyId = String(term.company_id);
    // Quem não enxerga a empresa não mexe nas demandas dela.
    if (allowedCompanyIds && !allowedCompanyIds.has(companyId)) continue;
    const backupUserId = term.backup_user_id ? String(term.backup_user_id) : "";
    if (!backupUserId) { withoutBackup.push(companyId); continue; }
    const cards = await openCardsOf(d1, workspaceId, userId, [companyId]);
    if (!cards.length) continue;
    statements.push(...prepareReassignStatements(d1, workspaceId, cards, userId, backupUserId));
    moved.push({ companyId, backupUserId, cards: cards.length });
  }
  const total = moved.reduce((sum, item) => sum + item.cards, 0);
  if (total) {
    await requireActiveMembers(d1, workspaceId, moved.map((item) => item.backupUserId));
    statements.push(prepareAuditEvent({
      workspaceId, actorUserId: actor.userId, actorEmail: actor.email,
      action: "portfolio.handed_over", entityType: "workspace_member", entityId: userId,
      after: { moved },
      metadata: { reassignedCards: total },
      requestId: actor.requestId ?? null,
    }));
    await d1.batch(statements);
  }
  return { reassigned: total, moved, withoutBackup };
}
