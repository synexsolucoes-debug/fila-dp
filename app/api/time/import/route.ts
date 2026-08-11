import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { parseTimeEntryPayload } from "@/lib/time-tracking";
import { ensureTimeSheet, recalculateTimeSheet, requireOpenTimeCycle, saveTimeEntries } from "@/lib/time-service";

export const dynamic = "force-dynamic";

const MAX_EMPLOYEES = 200;
const MAX_DAYS = 40;

/**
 * Importa marcações de ponto de vários colaboradores em uma competência.
 *
 * O identificador aceito é a matrícula ou o id do colaborador já cadastrado:
 * a importação não cria colaborador. Quem não é encontrado volta na resposta
 * como recusado, com o motivo — importar "quase tudo" em silêncio esconderia
 * exatamente o erro que o DP precisa ver.
 */
export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "time.manage");

    const companyId = cleanText(body.companyId, 120);
    const cycleId = cleanText(body.competenceId ?? body.payrollCycleId, 120);
    if (!companyId || !cycleId) throw ApiError.badRequest("Empresa e competência são obrigatórias.", "TIME_IMPORT_REQUIRED_FIELDS");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const cycle = await requireOpenTimeCycle(d1, workspace.id, companyId, cycleId);

    const rows = Array.isArray(body.employees) ? body.employees : [];
    if (!rows.length) throw ApiError.badRequest("Envie ao menos um colaborador na importação.", "TIME_IMPORT_EMPTY");
    if (rows.length > MAX_EMPLOYEES) throw ApiError.badRequest(`Envie no máximo ${MAX_EMPLOYEES} colaboradores por importação.`, "REQUEST_TOO_LARGE");

    const today = new Date().toISOString().slice(0, 10);
    const imported: { employeeId: string; sheetId: string; days: number; blockingIssues: number }[] = [];
    const rejected: { reference: string; reason: string }[] = [];

    for (const raw of rows) {
      const entry = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const employeeId = cleanText(entry.employeeId, 120);
      const registration = cleanText(entry.registrationNumber, 60);
      const reference = employeeId || registration || "(sem identificação)";
      const days = Array.isArray(entry.days) ? entry.days : [];
      if (days.length > MAX_DAYS) {
        rejected.push({ reference, reason: `Envie no máximo ${MAX_DAYS} dias por colaborador.` });
        continue;
      }

      const employee = employeeId
        ? await d1.prepare("SELECT id FROM fdp_employees WHERE workspace_id = ? AND company_id = ? AND id = ?")
          .bind(workspace.id, companyId, employeeId).first<{ id: string }>()
        : registration
          ? await d1.prepare("SELECT id FROM fdp_employees WHERE workspace_id = ? AND company_id = ? AND registration_number = ?")
            .bind(workspace.id, companyId, registration).first<{ id: string }>()
          : null;
      if (!employee) {
        rejected.push({ reference, reason: "Colaborador não encontrado nesta empresa." });
        continue;
      }

      try {
        const parsed = days.map((day) => parseTimeEntryPayload(day, "import"));
        const sheet = await ensureTimeSheet(d1, {
          workspaceId: workspace.id, companyId, employeeId: String(employee.id), cycle, userId: user.id, source: "import",
        });
        if (sheet.status === "exported" || sheet.status === "closed") {
          rejected.push({ reference, reason: "A folha de ponto já foi exportada. Reabra com justificativa antes de importar." });
          continue;
        }
        await saveTimeEntries(d1, {
          workspaceId: workspace.id, companyId, sheetId: sheet.id, employeeId: String(employee.id),
          entries: parsed, userId: user.id, today,
        });
        const recalculated = await recalculateTimeSheet(d1, workspace.id, sheet.id, { today });
        imported.push({
          employeeId: String(employee.id), sheetId: sheet.id, days: parsed.length,
          blockingIssues: recalculated.openBlockingIssues,
        });
      } catch (cause) {
        // Um dia inválido reprova o colaborador, não a importação inteira.
        rejected.push({ reference, reason: cause instanceof ApiError ? cause.message : "Marcação inválida." });
      }
    }

    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "time_sheet.imported", entityType: "payroll_cycle", entityId: cycle.id,
      after: { competence: cycle.competence, companyId, imported: imported.length, rejected: rejected.length },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return Response.json({ competence: cycle.competence, imported, rejected }, { status: rejected.length ? 207 : 201 });
  } catch (error) {
    return apiError(error);
  }
}
