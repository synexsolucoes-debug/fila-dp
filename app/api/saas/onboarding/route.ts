import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { requireCapability } from "@/lib/authorization";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { onboardingSteps, parseStringArray, sanitizeOnboardingProfile, validOnboardingStep } from "@/lib/saas";

type Body = { action?: string; step?: string; profile?: unknown };

export async function PATCH(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "saas.manage");
    const body = await request.json() as Body;
    const action = String(body.action ?? "");
    if (!new Set(["complete", "skip", "profile", "dismiss", "resume"]).has(action)) {
      return Response.json({ error: "Ação de onboarding inválida." }, { status: 400 });
    }
    const current = await d1.prepare(`SELECT status, current_step, completed_steps_json, skipped_steps_json, profile_json
      FROM fdp_workspace_onboarding WHERE workspace_id = ?`).bind(workspace.id).first<Record<string, unknown>>();
    if (!current) return Response.json({ error: "Onboarding não encontrado." }, { status: 404 });

    const completed = new Set(parseStringArray(current.completed_steps_json));
    const skipped = new Set(parseStringArray(current.skipped_steps_json));
    let profile = sanitizeOnboardingProfile(current.profile_json);
    let status = String(current.status);

    if (action === "profile") profile = sanitizeOnboardingProfile(body.profile);
    if (action === "dismiss") status = "dismissed";
    if (action === "resume") status = "in_progress";
    if (action === "complete" || action === "skip") {
      const step = validOnboardingStep(body.step);
      if (action === "skip" && step !== "integrations" && step !== "billing") {
        return Response.json({ error: "Esta etapa é obrigatória para concluir a configuração." }, { status: 400 });
      }
      if (action === "complete") { completed.add(step); skipped.delete(step); }
      else { skipped.add(step); completed.delete(step); }
      status = "in_progress";
    }

    const nextStep = onboardingSteps.find((step) => !completed.has(step) && !skipped.has(step));
    if (!nextStep) status = "completed";
    const currentStep = nextStep ?? "completed";
    const before = { status: String(current.status), currentStep: String(current.current_step) };
    const after = { status, currentStep, completedSteps: [...completed], skippedSteps: [...skipped] };
    const requestId = request.headers.get("x-fila-dp-request-id");
    await d1.batch([
      d1.prepare(`UPDATE fdp_workspace_onboarding SET status = ?, current_step = ?, completed_steps_json = ?::jsonb,
          skipped_steps_json = ?::jsonb, profile_json = ?::jsonb,
          completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, CURRENT_TIMESTAMP) ELSE NULL END,
          updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ?`)
        .bind(status, currentStep, JSON.stringify([...completed]), JSON.stringify([...skipped]), JSON.stringify(profile), status, workspace.id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: user.email, action: `saas.onboarding_${action}`, entityType: "workspace_onboarding", entityId: workspace.id, before, after, requestId }),
    ]);
    return Response.json({ onboarding: { ...after, profile } });
  } catch (error) { return apiError(error); }
}
