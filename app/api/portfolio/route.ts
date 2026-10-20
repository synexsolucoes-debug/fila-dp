import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";
import { todayInBrazil } from "@/lib/employee-history";
import { isDpStatus } from "@/lib/portfolio";
import { transferPortfolio } from "@/lib/portfolio-service";

/**
 * Demanda em aberto aqui é o mesmo recorte de `OPEN_CARD_CONDITION`
 * (lib/portfolio-assignment.ts), escrito por extenso para a consulta ser
 * preparada inteira pelo `verify:sql`.
 *
 * Tela "Carteira": uma linha por empresa, com titular, backup, situação,
 * ativos e demandas em aberto.
 *
 * Ativos vêm de `fdp_employees`, que a sincronização com o Sankhya mantém. O
 * mesmo CPF não aparece em duas empresas — o cadastro é único por CPF no
 * grupo, e a sincronização ignora o registro de empresa `sem_funcionarios`.
 */
export async function GET() {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "portfolio.read", "consultar a carteira do DP");
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    // SQL estático (verificável por `verify:sql`): o recorte por empresa é a
    // própria tabela de acesso, ligada ou não pelo primeiro parâmetro.
    const unrestricted = access.unrestricted;
    const [companies, members, absences, unassigned] = await Promise.all([
      d1.prepare(`SELECT co.id, co.legal_name, co.trade_name, co.tax_id, co.external_code, co.status,
          co.dp_status, co.cnpj_root, co.is_headquarters,
          p.id AS term_id, p.holder_user_id, p.backup_user_id, p.valid_from::text AS valid_from,
          holder.name AS holder_name, backup.name AS backup_name,
          (SELECT COUNT(*)::int FROM fdp_employees e
            WHERE e.workspace_id = co.workspace_id AND e.company_id = co.id AND e.employment_status = 'active') AS active_employees,
          (SELECT COUNT(*)::int FROM fdp_cards c
            WHERE c.workspace_id = co.workspace_id AND c.company_id = co.id
              AND c.archived = 0 AND c.closed_at IS NULL AND c.sla_status <> 'completed') AS open_cards,
          (SELECT COUNT(*)::int FROM fdp_cards c
            WHERE c.workspace_id = co.workspace_id AND c.company_id = co.id
              AND c.archived = 0 AND c.closed_at IS NULL AND c.sla_status <> 'completed'
              AND NOT EXISTS (SELECT 1 FROM fdp_card_assignees ca WHERE ca.workspace_id = c.workspace_id AND ca.card_id = c.id)) AS unassigned_cards,
          -- O que a troca de titular moveria: a confirmação diz o número antes.
          (SELECT COUNT(*)::int FROM fdp_cards c
            WHERE c.workspace_id = co.workspace_id AND c.company_id = co.id
              AND c.archived = 0 AND c.closed_at IS NULL AND c.sla_status <> 'completed'
              AND EXISTS (SELECT 1 FROM fdp_card_assignees ca WHERE ca.workspace_id = c.workspace_id AND ca.card_id = c.id AND ca.user_id = p.holder_user_id)) AS holder_open_cards
        FROM fdp_companies co
        LEFT JOIN fdp_company_portfolio p ON p.workspace_id = co.workspace_id AND p.company_id = co.id AND p.valid_to IS NULL
        LEFT JOIN fdp_users holder ON holder.id = p.holder_user_id
        LEFT JOIN fdp_users backup ON backup.id = p.backup_user_id
        WHERE co.workspace_id = ? AND co.status = 'active'
          AND (? OR co.id IN (SELECT mca.company_id FROM fdp_member_company_access mca WHERE mca.workspace_id = co.workspace_id AND mca.user_id = ?))
        ORDER BY NULLIF(co.external_code, '') IS NULL, co.external_code, co.legal_name`)
        .bind(workspace.id, unrestricted, user.id).all<Record<string, unknown>>(),
      d1.prepare(`SELECT u.id, u.name, u.email FROM fdp_workspace_members wm JOIN fdp_users u ON u.id = wm.user_id
        WHERE wm.workspace_id = ? AND wm.role IN ('admin', 'member') ORDER BY u.name`)
        .bind(workspace.id).all<Record<string, unknown>>(),
      d1.prepare(`SELECT a.id, a.user_id, u.name AS user_name, a.starts_on::text AS starts_on, a.ends_on::text AS ends_on, a.reason
        FROM fdp_member_absences a JOIN fdp_users u ON u.id = a.user_id
        WHERE a.workspace_id = ? AND a.ends_on >= (CURRENT_DATE - 30) ORDER BY a.starts_on`)
        .bind(workspace.id).all<Record<string, unknown>>(),
      // Demanda sem empresa não tem carteira: entra só no total "sem responsável".
      d1.prepare(`SELECT COUNT(*)::int AS total FROM fdp_cards c
        WHERE c.workspace_id = ? AND c.archived = 0 AND c.closed_at IS NULL AND c.sla_status <> 'completed'
          AND (? OR c.company_id IN (SELECT mca.company_id FROM fdp_member_company_access mca WHERE mca.workspace_id = c.workspace_id AND mca.user_id = ?))
          AND NOT EXISTS (SELECT 1 FROM fdp_card_assignees ca WHERE ca.workspace_id = c.workspace_id AND ca.card_id = c.id)`)
        .bind(workspace.id, unrestricted, user.id).first<{ total: number }>(),
    ]);
    return Response.json({
      today: todayInBrazil(),
      unassignedCards: Number(unassigned?.total ?? 0),
      companies: companies.results.map((row) => ({
        id: String(row.id),
        code: String(row.external_code ?? ""),
        name: String(row.trade_name || row.legal_name),
        legalName: String(row.legal_name),
        taxId: String(row.tax_id ?? ""),
        cnpjRoot: String(row.cnpj_root ?? ""),
        isHeadquarters: Boolean(row.is_headquarters),
        dpStatus: String(row.dp_status),
        holderUserId: row.holder_user_id ? String(row.holder_user_id) : null,
        holderName: row.holder_name ? String(row.holder_name) : null,
        backupUserId: row.backup_user_id ? String(row.backup_user_id) : null,
        backupName: row.backup_name ? String(row.backup_name) : null,
        validFrom: row.valid_from ? String(row.valid_from) : null,
        activeEmployees: Number(row.active_employees ?? 0),
        openCards: Number(row.open_cards ?? 0),
        unassignedCards: Number(row.unassigned_cards ?? 0),
        holderOpenCards: Number(row.holder_open_cards ?? 0),
      })),
      members: members.results.map((row) => ({ id: String(row.id), name: String(row.name), email: String(row.email) })),
      absences: absences.results.map((row) => ({
        id: String(row.id), userId: String(row.user_id), userName: String(row.user_name),
        startsOn: String(row.starts_on), endsOn: String(row.ends_on), reason: String(row.reason ?? ""),
      })),
    });
  } catch (error) { return apiError(error); }
}

/** Troca titular e/ou backup a partir de uma data (padrão: hoje). */
export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "portfolio.manage", "trocar a carteira do DP");
    const companyId = cleanText(body.companyId, 120);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId || null);
    const result = await transferPortfolio(d1, workspace.id, {
      userId: user.id, email: auth.user.email, requestId: request.headers.get("x-fila-dp-request-id"),
    }, {
      companyId,
      holderUserId: cleanText(body.holderUserId, 120),
      backupUserId: cleanText(body.backupUserId, 120) || null,
      validFrom: cleanText(body.validFrom, 10) || todayInBrazil(),
    });
    return Response.json(result);
  } catch (error) { return apiError(error); }
}

/** Situação da empresa para o DP (interno, a internalizar, sem funcionários, terceirizado). */
export async function PATCH(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "portfolio.manage", "alterar a situação da empresa no DP");
    const companyId = cleanText(body.companyId, 120);
    if (!isDpStatus(body.dpStatus)) throw ApiError.badRequest("Situação inválida.", "PORTFOLIO_DP_STATUS_INVALID");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId || null);
    const company = await d1.prepare("SELECT dp_status FROM fdp_companies WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, companyId).first<{ dp_status: string }>();
    if (!company) throw ApiError.notFound("Empresa não encontrada.", "PORTFOLIO_COMPANY_NOT_FOUND");
    if (company.dp_status === body.dpStatus) return Response.json({ changed: false });
    await d1.batch([
      d1.prepare("UPDATE fdp_companies SET dp_status = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?")
        .bind(body.dpStatus, workspace.id, companyId),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "company.dp_status_changed", entityType: "company", entityId: companyId,
        before: { dpStatus: company.dp_status }, after: { dpStatus: body.dpStatus },
        metadata: { scope: "company", companyId },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ changed: true });
  } catch (error) { return apiError(error); }
}
