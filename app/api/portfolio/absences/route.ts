import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";
import { isIsoDate } from "@/lib/portfolio";

/**
 * Férias e folgas da equipe. Na data em que o titular está ausente, demanda
 * nova da empresa dele nasce com o backup (`responsavelPara`). As que já estão
 * com ele só mudam pelo botão "Passar abertas para o backup".
 */
export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "portfolio.manage", "registrar ausências da equipe");
    const userId = cleanText(body.userId, 120);
    const startsOn = cleanText(body.startsOn, 10);
    const endsOn = cleanText(body.endsOn, 10);
    const reason = cleanText(body.reason, 200);
    if (!userId) throw ApiError.badRequest("Selecione quem estará ausente.", "ABSENCE_USER_REQUIRED");
    if (!isIsoDate(startsOn) || !isIsoDate(endsOn)) throw ApiError.badRequest("Informe o início e o fim da ausência.", "ABSENCE_PERIOD_REQUIRED");
    if (endsOn < startsOn) throw ApiError.badRequest("O fim da ausência precisa ser igual ou posterior ao início.", "ABSENCE_PERIOD_INVALID");
    const member = await d1.prepare("SELECT 1 FROM fdp_workspace_members WHERE workspace_id = ? AND user_id = ? AND role IN ('admin', 'member')")
      .bind(workspace.id, userId).first();
    if (!member) throw ApiError.badRequest("A pessoa precisa ser membro ativo do grupo.", "ABSENCE_MEMBER_INVALID");
    const id = crypto.randomUUID();
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_member_absences (id, workspace_id, user_id, starts_on, ends_on, reason, created_by)
        VALUES (?, ?, ?, ?::date, ?::date, ?, ?)`).bind(id, workspace.id, userId, startsOn, endsOn, reason, user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "member_absence.created", entityType: "member_absence", entityId: id,
        after: { userId, startsOn, endsOn },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ absence: { id, userId, startsOn, endsOn, reason } }, { status: 201 });
  } catch (error) { return apiError(error); }
}
