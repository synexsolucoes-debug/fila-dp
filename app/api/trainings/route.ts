import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";
import { parseTrainingInput, trainingFromRow } from "@/lib/trainings";

/**
 * Um colaborador por vez: a tela de treinamentos vive dentro da ficha dele
 * (`EmployeeTrainingsPanel`), no mesmo padrão de `/api/occupational-exams`.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "trainings.view", "consultar treinamentos obrigatórios");
    const employeeId = cleanText(new URL(request.url).searchParams.get("employeeId"), 120);
    if (!employeeId) throw ApiError.badRequest("Selecione o colaborador.", "TRAINING_EMPLOYEE_REQUIRED");
    const employee = await d1.prepare("SELECT company_id FROM fdp_employees WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, employeeId).first<{ company_id: string }>();
    if (!employee) throw ApiError.notFound("Colaborador não encontrado.", "TRAINING_EMPLOYEE_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, employee.company_id);
    const result = await d1.prepare(`SELECT * FROM fdp_trainings
      WHERE workspace_id = ? AND employee_id = ? ORDER BY completed_on DESC, created_at DESC`)
      .bind(workspace.id, employeeId).all<Record<string, unknown>>();
    return Response.json({ trainings: result.results.map(trainingFromRow) });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "trainings.manage", "registrar um treinamento obrigatório");
    const input = parseTrainingInput(body);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, input.companyId);
    const employee = await d1.prepare("SELECT id FROM fdp_employees WHERE workspace_id = ? AND company_id = ? AND id = ?")
      .bind(workspace.id, input.companyId, input.employeeId).first();
    if (!employee) throw ApiError.badRequest("O colaborador não pertence à empresa selecionada.", "TRAINING_EMPLOYEE_INVALID");

    const id = crypto.randomUUID();
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_trainings
        (id, workspace_id, company_id, employee_id, training_name, completed_on, valid_until,
         provider_name, certificate_number, notes, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, workspace.id, input.companyId, input.employeeId, input.trainingName, input.completedOn,
          input.validUntil, input.providerName, input.certificateNumber, input.notes, user.id, user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "training.created", entityType: "training", entityId: id,
        after: { companyId: input.companyId, employeeId: input.employeeId, trainingName: input.trainingName, completedOn: input.completedOn, validUntil: input.validUntil },
        metadata: { scope: "company", companyId: input.companyId },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ training: { id, ...input } }, { status: 201 });
  } catch (error) { return apiError(error); }
}
