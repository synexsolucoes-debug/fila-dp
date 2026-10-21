import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { templateBody, validateTemplateInput } from "@/lib/dp-recurring";
import { loadRecurringTemplates } from "@/lib/dp-recurring-service";

export async function GET() {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "portfolio.read", "consultar as rotinas do DP");
    return Response.json({ templates: await loadRecurringTemplates(d1, workspace.id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "portfolio.manage", "criar rotinas do DP");
    const input = templateBody(body);
    const problem = validateTemplateInput(input);
    if (problem) throw ApiError.badRequest(problem, "RECURRING_TEMPLATE_INVALID");
    const exists = await d1.prepare("SELECT 1 FROM fdp_recurring_templates WHERE workspace_id = ? AND code = ?").bind(workspace.id, input.code).first();
    if (exists) throw new ApiError(409, "RECURRING_TEMPLATE_EXISTS", "Já existe uma rotina com esse código.");
    const id = crypto.randomUUID();
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_recurring_templates
        (id, workspace_id, code, name, description, frequency, day_start, day_end, weekday, scope, company_ids, process_type, list_week_movements, active, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?)`)
        .bind(id, workspace.id, input.code, input.name, input.description ?? "", input.frequency,
          input.frequency === "weekly" ? 1 : input.dayStart, input.frequency === "weekly" ? 1 : input.dayEnd,
          input.weekday ?? null, input.scope, input.companyIds ? JSON.stringify(input.companyIds) : null,
          input.processType, input.listWeekMovements ?? false, input.active ?? true, user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "recurring_template.created", entityType: "recurring_template", entityId: id,
        after: { ...input }, requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ id }, { status: 201 });
  } catch (error) { return apiError(error); }
}
