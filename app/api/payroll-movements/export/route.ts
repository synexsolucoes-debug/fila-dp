import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import {
  buildMovementExport, normalizeTipmov, parseCompetence, sankhyaCompanyCode, sankhyaEmployeeCode, type MovementForExport,
} from "@/lib/payroll-movements";
import { buildMovementWorkbook } from "@/lib/payroll-movements-xlsx";
import { loadEventCatalog } from "@/lib/payroll-movements-service";

/**
 * A planilha do Importador de Movimentos do Sankhya. É POST porque marca os
 * lançamentos como exportados.
 *
 * Com `companyId`, sai só aquela empresa; sem, saem todas as empresas que a
 * pessoa enxerga — o layout já leva o CODEMP em cada linha.
 *
 * Qualquer problema (empresa sem Código Sankhya, colaborador sem CODFUNC,
 * evento fora do catálogo ou inativo) bloqueia o arquivo inteiro e volta
 * nomeado. Exportar marca os lançamentos com data e autor e fica na auditoria;
 * não trava nada, porque quem fecha a folha é o Sankhya.
 */
export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const competence = parseCompetence(body.competence);
    const companyId = text(body.companyId, 120);
    const tipmov = normalizeTipmov(body.tipmov);
    if (!competence) throw ApiError.badRequest("Informe a competência (AAAA-MM).", "PAYROLL_MOVEMENT_SCOPE");

    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "hr.write");
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);

    const result = await d1.prepare(`SELECT mv.id, mv.company_id, mv.event_code, mv.index_value, mv.amount_cents, mv.created_at,
        emp.full_name, emp.registration_number, emp.external_id, co.external_code
      FROM fdp_payroll_movement_entries mv
      JOIN fdp_employees emp ON emp.workspace_id = mv.workspace_id AND emp.id = mv.employee_id
      JOIN fdp_companies co ON co.workspace_id = mv.workspace_id AND co.id = mv.company_id
      WHERE mv.workspace_id = ? AND mv.competence = ? AND (? = '' OR mv.company_id = ?)
      ORDER BY mv.company_id, emp.full_name, mv.event_code, mv.created_at`)
      .bind(workspace.id, competence, companyId, companyId).all<Record<string, unknown>>();
    const visible = result.results.filter((row) => access.unrestricted || access.companyIds.has(String(row.company_id)));
    if (!visible.length) throw ApiError.badRequest("Não há lançamentos nesta competência para exportar.", "PAYROLL_MOVEMENT_NOTHING");

    const entries: MovementForExport[] = visible.map((row) => ({
      id: String(row.id),
      companyCode: sankhyaCompanyCode(String(row.external_code ?? "")),
      employeeCode: sankhyaEmployeeCode({ externalId: String(row.external_id ?? ""), registrationNumber: String(row.registration_number ?? "") }),
      employeeName: String(row.full_name ?? ""),
      eventCode: Number(row.event_code),
      indexValue: Number(row.index_value ?? 0),
      amountCents: Number(row.amount_cents ?? 0),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ""),
    }));
    const catalog = await loadEventCatalog(d1, workspace.id);
    const built = buildMovementExport({ competence, tipmov, entries, events: catalog.events });
    if (built.problems.length) {
      throw new ApiError(400, "PAYROLL_MOVEMENT_EXPORT_BLOCKED",
        `${built.problems.length} problema(s) impedem a planilha. Corrija e exporte de novo.`,
        { problems: built.problems.slice(0, 50) });
    }

    const buffer = await buildMovementWorkbook(built.rows);
    const ids = entries.map((entry) => entry.id);
    await d1.batch([
      ...ids.map((id) => d1.prepare(`UPDATE fdp_payroll_movement_entries
        SET exported_at = now(), exported_by = ?, updated_at = now() WHERE workspace_id = ? AND id = ?`)
        .bind(user.id, workspace.id, id)),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "payroll_movements.exported", entityType: "payroll_movements", entityId: companyId || workspace.id,
        after: { competence, rows: built.rows.length, tipmov },
        metadata: { companyId: companyId || null },
      }),
    ]);

    const nome = `movimentos-sankhya-${competence}${companyId ? `-${built.rows[0]?.companyCode ?? ""}` : ""}.xlsx`;
    return new Response(buffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${nome}"`,
        "Cache-Control": "no-store",
        "X-Fila-Dp-Rows": String(built.rows.length),
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
