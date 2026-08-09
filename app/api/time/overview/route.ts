import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { validCompetence } from "@/lib/operations";
import { computedHourEventCodes, hourEventCodes, hourEventLabels, timeInconsistencyLabels } from "@/lib/time-tracking";

export const dynamic = "force-dynamic";

/**
 * Painel de conferência de ponto da competência.
 *
 * Devolve o que a tela precisa para responder "o ponto está pronto para ir para
 * a folha?": as folhas do período, o que está inconsistente, os eventos de hora
 * apurados e — o ponto crítico do §22 — quais desses eventos ainda não têm
 * rubrica de destino configurada.
 */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "time.read");

    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    if (!companyId) throw ApiError.badRequest("Selecione uma empresa.", "COMPANY_REQUIRED");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const destination = cleanText(url.searchParams.get("destination"), 60) || "folha";

    const cycles = await d1.prepare(`SELECT id, competence, status, payment_date, closed_at FROM fdp_payroll_cycles
      WHERE workspace_id = ? AND company_id = ? ORDER BY competence DESC LIMIT 36`)
      .bind(workspace.id, companyId).all<Record<string, unknown>>();
    const requested = url.searchParams.get("competence") ? validCompetence(url.searchParams.get("competence")) : "";
    const competence = requested || String(cycles.results[0]?.competence ?? new Date().toISOString().slice(0, 7));
    const cycle = cycles.results.find((item) => item.competence === competence) ?? null;
    const cycleId = cycle ? String(cycle.id) : "";

    const empty = { results: [] as Record<string, unknown>[] };
    const [sheets, events, issues, mappings, exports] = await Promise.all([
      cycleId
        ? d1.prepare(`SELECT s.id, s.employee_id, s.competence, s.status, s.source, s.entries_count, s.worked_minutes,
            s.expected_minutes, s.balance_minutes, s.blocking_issues, s.warning_issues, s.approved_at, s.exported_at,
            s.export_id, s.rejected_reason, e.registration_number, e.full_name
          FROM fdp_time_sheets s JOIN fdp_employees e ON e.workspace_id = s.workspace_id AND e.id = s.employee_id
          WHERE s.workspace_id = ? AND s.company_id = ? AND s.payroll_cycle_id = ?
          ORDER BY e.registration_number`).bind(workspace.id, companyId, cycleId).all<Record<string, unknown>>()
        : Promise.resolve(empty),
      cycleId
        ? d1.prepare(`SELECT v.event_code, sum(v.minutes)::int AS minutes, count(*)::int AS sheets
          FROM fdp_time_sheet_events v JOIN fdp_time_sheets s ON s.workspace_id = v.workspace_id AND s.id = v.time_sheet_id
          WHERE v.workspace_id = ? AND s.company_id = ? AND s.payroll_cycle_id = ? AND v.minutes > 0
          GROUP BY v.event_code ORDER BY v.event_code`).bind(workspace.id, companyId, cycleId).all<Record<string, unknown>>()
        : Promise.resolve(empty),
      cycleId
        ? d1.prepare(`SELECT i.id, i.time_sheet_id, i.entry_date, i.kind, i.severity, i.detail, i.status, i.resolution_note,
            e.registration_number, e.full_name
          FROM fdp_time_inconsistencies i
          JOIN fdp_time_sheets s ON s.workspace_id = i.workspace_id AND s.id = i.time_sheet_id
          JOIN fdp_employees e ON e.workspace_id = s.workspace_id AND e.id = s.employee_id
          WHERE i.workspace_id = ? AND s.company_id = ? AND s.payroll_cycle_id = ?
          ORDER BY i.severity, i.entry_date, i.kind LIMIT 500`).bind(workspace.id, companyId, cycleId).all<Record<string, unknown>>()
        : Promise.resolve(empty),
      d1.prepare(`SELECT id, event_code, rubric_code, target_field, unit, destination, status, note
        FROM fdp_hour_event_mappings WHERE workspace_id = ? AND company_id = ? ORDER BY destination, event_code`)
        .bind(workspace.id, companyId).all<Record<string, unknown>>(),
      cycleId
        ? d1.prepare(`SELECT id, destination, status, sheets_count, lines_count, checksum, created_at
          FROM fdp_time_exports WHERE workspace_id = ? AND payroll_cycle_id = ? ORDER BY created_at DESC LIMIT 10`)
          .bind(workspace.id, cycleId).all<Record<string, unknown>>()
        : Promise.resolve(empty),
    ]);

    // §22: qualquer evento apurado sem mapeamento ativo no destino bloqueia a exportação.
    const mapped = new Set(mappings.results
      .filter((row) => String(row.destination) === destination && String(row.status) === "active")
      .map((row) => String(row.event_code)));
    const missingMappings = events.results
      .map((row) => String(row.event_code))
      .filter((code) => !mapped.has(code));

    const approvedSheets = sheets.results.filter((row) => String(row.status) === "approved").length;
    const openBlocking = issues.results.filter((row) => String(row.status) === "open" && String(row.severity) === "blocking").length;

    return Response.json({
      competence,
      cycle,
      cycles: cycles.results,
      destination,
      sheets: sheets.results,
      events: events.results,
      inconsistencies: issues.results,
      mappings: mappings.results,
      exports: exports.results,
      summary: {
        sheets: sheets.results.length,
        approvedSheets,
        openBlockingIssues: openBlocking,
        openWarningIssues: issues.results.filter((row) => String(row.status) === "open" && String(row.severity) === "warning").length,
        missingMappings,
        exportReady: approvedSheets > 0 && missingMappings.length === 0,
      },
      catalog: {
        hourEvents: hourEventCodes.map((code) => ({ code, label: hourEventLabels[code], computed: computedHourEventCodes.includes(code) })),
        inconsistencyLabels: timeInconsistencyLabels,
      },
      permissions: {
        manage: hasCapability(workspace.role, "time.manage"),
        approve: hasCapability(workspace.role, "time.approve"),
        export: hasCapability(workspace.role, "time.export"),
        manageMappings: hasCapability(workspace.role, "time.mappings.manage"),
      },
      boundary: "O Fila DP confere horas e prepara o envio para a folha. A conversão de hora em dinheiro pertence ao sistema de folha.",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
