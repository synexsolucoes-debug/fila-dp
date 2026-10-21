/**
 * Atribuição pela carteira — a parte que toda criação de demanda importa.
 *
 * Separada de `portfolio-service.ts` porque é chamada de dentro de módulos de
 * domínio (`process-instances.ts`, integrações) que precisam continuar
 * importáveis sem a camada de API. A regra está em `lib/portfolio.ts`.
 *
 * `responsavelPara` é a função que toda criação de demanda consulta quando
 * ninguém foi escolhido explicitamente. `preparePortfolioAssignment` devolve os
 * statements para entrar no **mesmo lote** da criação: demanda e responsável
 * nascem juntos ou não nascem.
 */
import type { getD1 } from "../db/index.ts";
import { todayInBrazil } from "./employee-history.ts";
import { resolveResponsible, type MemberAbsence, type PortfolioTerm, type ResponsibleResolution } from "./portfolio.ts";

type Database = ReturnType<typeof getD1>;
type Row = Record<string, unknown>;

/**
 * Demanda em aberto: o mesmo recorte da fonte `card` da Central de Trabalho
 * (`lib/work-items.ts`), mais a coluna de concluídas. Concluída não muda de
 * responsável em troca de carteira — ela registra quem fez.
 */
export const OPEN_CARD_CONDITION = "c.archived = 0 AND c.closed_at IS NULL AND c.sla_status <> 'completed'";

export function termFromRow(row: Row): PortfolioTerm {
  return {
    companyId: String(row.company_id),
    holderUserId: String(row.holder_user_id),
    backupUserId: row.backup_user_id ? String(row.backup_user_id) : null,
    validFrom: String(row.valid_from),
    validTo: row.valid_to ? String(row.valid_to) : null,
  };
}

/**
 * `responsavelPara(empresa, data)`.
 *
 * Quem deixou de ser membro do grupo (ou virou só leitura) conta como ausente:
 * a vigência continua apontando para a pessoa, porque é histórico, mas atribuir
 * a ela uma demanda nova seria entregar trabalho a quem não pode abri-lo.
 */
export async function responsavelPara(d1: Database, workspaceId: string, companyId: string | null | undefined, date = todayInBrazil()): Promise<ResponsibleResolution> {
  if (!companyId) return { userId: null, via: null, holderUserId: null };
  const terms = await d1.prepare(`SELECT company_id, holder_user_id, backup_user_id, valid_from::text AS valid_from, valid_to::text AS valid_to
    FROM fdp_company_portfolio
    WHERE workspace_id = ? AND company_id = ? AND valid_from <= ?::date AND (valid_to IS NULL OR valid_to >= ?::date)`)
    .bind(workspaceId, companyId, date, date).all<Row>();
  if (!terms.results.length) return { userId: null, via: null, holderUserId: null };
  const parsed = terms.results.map(termFromRow);
  const people = [...new Set(parsed.flatMap((term) => [term.holderUserId, term.backupUserId].filter((id): id is string => Boolean(id))))];
  const [absences, members] = await Promise.all([
    d1.prepare(`SELECT user_id, starts_on::text AS starts_on, ends_on::text AS ends_on FROM fdp_member_absences
      WHERE workspace_id = ? AND user_id IN (${people.map(() => "?").join(",")}) AND starts_on <= ?::date AND ends_on >= ?::date`)
      .bind(workspaceId, ...people, date, date).all<Row>(),
    d1.prepare(`SELECT user_id FROM fdp_workspace_members
      WHERE workspace_id = ? AND user_id IN (${people.map(() => "?").join(",")}) AND role IN ('admin', 'member')`)
      .bind(workspaceId, ...people).all<Row>(),
  ]);
  const active = new Set(members.results.map((row) => String(row.user_id)));
  const unavailable: MemberAbsence[] = [
    ...absences.results.map((row) => ({ userId: String(row.user_id), startsOn: String(row.starts_on), endsOn: String(row.ends_on) })),
    ...people.filter((id) => !active.has(id)).map((userId) => ({ userId, startsOn: date, endsOn: date })),
  ];
  return resolveResponsible(parsed, unavailable, companyId, date);
}

/**
 * Statements que atribuem a demanda recém-criada pela carteira.
 *
 * Entram depois do `INSERT` da demanda, no mesmo lote. Sem responsável na
 * carteira, nada é gravado e a demanda aparece em "Sem responsável".
 */
export async function preparePortfolioAssignment(d1: Database, input: {
  workspaceId: string; cardId: string; companyId: string | null | undefined; date?: string;
}) {
  const resolution = await responsavelPara(d1, input.workspaceId, input.companyId, input.date);
  if (!resolution.userId) return { resolution, statements: [] as D1PreparedStatement[] };
  return {
    resolution,
    statements: prepareAssigneeStatements(d1, input.workspaceId, input.cardId, resolution.userId),
  };
}

/**
 * Atribui um responsável e mantém `assignee_name` (o nome que o quadro mostra).
 *
 * O `INSERT ... SELECT` só grava se a pessoa ainda for membro: entre a leitura
 * e o lote alguém pode ter sido removido, e a chave estrangeira derrubaria a
 * criação da demanda inteira por causa do responsável.
 */
export function prepareAssigneeStatements(d1: Database, workspaceId: string, cardId: string, userId: string) {
  return [
    d1.prepare(`INSERT INTO fdp_card_assignees (workspace_id, card_id, user_id)
      SELECT wm.workspace_id, ?, wm.user_id FROM fdp_workspace_members wm
      WHERE wm.workspace_id = ? AND wm.user_id = ?
      ON CONFLICT (card_id, user_id) DO NOTHING`).bind(cardId, workspaceId, userId),
    d1.prepare(`UPDATE fdp_cards SET assignee_name = COALESCE((SELECT name FROM fdp_users WHERE id = ?), assignee_name), updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND id = ?
        AND EXISTS (SELECT 1 FROM fdp_card_assignees ca WHERE ca.workspace_id = ? AND ca.card_id = ? AND ca.user_id = ?)`)
      .bind(userId, workspaceId, cardId, workspaceId, cardId, userId),
  ];
}
