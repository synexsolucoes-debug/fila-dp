import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { buildLedgerWorkbook, type LedgerExportRow } from "@/lib/ledger-export";
import { ledgerCategoryLabels, type LedgerCategory } from "@/lib/payroll-ledger";

/**
 * A planilha da competência, para lançar na folha.
 *
 * **Exportar não confirma desconto.** A rota não escreve em parcela nenhuma: ela
 * lê, monta o arquivo e registra na auditoria que alguém levou esses dados para
 * fora. O que muda de estado é o lote — e por outra rota, com outra permissão.
 *
 * O arquivo leva o identificador de cada parcela na primeira coluna, para que o
 * retorno case linha a linha em vez de casar por nome. Nome não identifica
 * pessoa com segurança numa base com homônimos, e foi assim que a planilha
 * antiga somava desconto de gente diferente.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "ledger.export", "exportar a competência para lançamento na folha");

    const batch = await d1.prepare(`SELECT batch.id, batch.company_id, batch.competence, batch.status,
        COALESCE(NULLIF(company.trade_name, ''), company.legal_name) AS company_name
      FROM fdp_ledger_batches batch
      JOIN fdp_companies company
        ON company.workspace_id = batch.workspace_id AND company.id = batch.company_id
      WHERE batch.workspace_id = ? AND batch.id = ?`)
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (!batch) throw ApiError.notFound("Conferência não encontrada.", "LEDGER_BATCH_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(batch.company_id));

    /* Exportar antes de aprovar levaria para a folha um desconto que ninguém
       autorizou. A recusa nomeia a etapa que falta. */
    if (!["approved", "exported", "sent_to_payroll", "confirmed", "closed"].includes(String(batch.status))) {
      throw ApiError.badRequest(
        "A conferência precisa estar aprovada antes de ser exportada — exportar antes levaria para a folha um desconto que ninguém autorizou.",
        "LEDGER_BATCH_NOT_APPROVED",
      );
    }

    const competence = String(batch.competence);
    const result = await d1.prepare(`SELECT installment.id, installment.number, installment.total_count,
        installment.competence, installment.planned_amount, installment.discounted_amount,
        entry.title AS entry_title, entry.category, entry.unit_label, entry.department_label,
        employee.full_name AS employee_name, employee.registration_number,
        provider.legal_name AS provider_name,
        COALESCE(NULLIF(company.trade_name, ''), company.legal_name) AS company_name
      FROM fdp_ledger_installments installment
      JOIN fdp_ledger_entries entry
        ON entry.workspace_id = installment.workspace_id AND entry.id = installment.entry_id
      JOIN fdp_companies company
        ON company.workspace_id = installment.workspace_id AND company.id = installment.company_id
      LEFT JOIN fdp_employees employee
        ON employee.workspace_id = entry.workspace_id AND employee.id = entry.employee_id
      LEFT JOIN fdp_auxiliary_providers provider
        ON provider.workspace_id = entry.workspace_id AND provider.id = entry.provider_id
      WHERE installment.workspace_id = ? AND installment.company_id = ?
        AND installment.competence = ?
        AND installment.status NOT IN ('canceled', 'rescheduled', 'skipped')
        AND installment.discounted_amount < installment.planned_amount
        AND entry.status IN ('approved', 'active', 'suspended')
        AND entry.settlement_target = 'payroll'
      ORDER BY employee.full_name, installment.number`)
      .bind(workspace.id, String(batch.company_id), competence).all<Record<string, unknown>>();

    const rows: LedgerExportRow[] = result.results.map((row) => {
      const planned = Number(row.planned_amount ?? 0);
      const discounted = Number(row.discounted_amount ?? 0);
      return {
        id: String(row.id),
        employeeName: String(row.employee_name ?? row.provider_name ?? ""),
        registrationNumber: String(row.registration_number ?? ""),
        companyName: String(row.company_name ?? ""),
        unitLabel: String(row.unit_label ?? ""),
        departmentLabel: String(row.department_label ?? ""),
        category: ledgerCategoryLabels[String(row.category) as LedgerCategory] ?? String(row.category),
        entryTitle: String(row.entry_title ?? ""),
        installment: row.total_count
          ? `${Number(row.number)}/${Number(row.total_count)}`
          : String(Number(row.number)),
        competence,
        plannedAmount: planned,
        alreadyDiscounted: discounted,
        remainingAmount: Math.max(0, planned - discounted),
      };
    });

    const buffer = await buildLedgerWorkbook({
      competence,
      companyName: String(batch.company_name ?? ""),
      rows,
    });

    /* A auditoria registra que alguém levou estes dados para fora, com quantas
       linhas. Nomes e valores não entram na trilha: quem precisa do caso abre o
       módulo, onde a permissão vale. */
    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "ledger_batch.exported", entityType: "ledger_batch", entityId: id,
      after: { competence, rows: rows.length },
      metadata: { companyId: String(batch.company_id) },
    }).run();

    const nome = `descontos-${competence}-${String(batch.company_id).slice(0, 8)}.xlsx`;
    return new Response(buffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${nome}"`,
        "Cache-Control": "no-store",
        "X-Fila-Dp-Rows": String(rows.length),
      },
    });
  } catch (error) { return apiError(error); }
}
