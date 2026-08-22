import { requireCapability } from "@/lib/authorization";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { wakeTangerinoWorker } from "@/lib/tangerino/actions-dispatch";
import { admissionStatusLabels } from "@/lib/tangerino/status";
import {
  consultationHistory,
  enqueueConsultation,
  lastConsultation,
  loadConsultationTarget,
  requireTangerinoAgent,
  type ConsultationRow,
} from "@/lib/tangerino/queue";
import type { AdmissionStatus } from "@/lib/tangerino/types";

type Context = { params: Promise<{ employeeId: string }> };

/**
 * Consulta do andamento da admissão no Tangerino.
 *
 * `POST` pede uma consulta e responde `202` na hora; `GET` acompanha. A
 * requisição nunca espera o navegador terminar (§36): uma automação de tela leva
 * dezenas de segundos, e uma conexão HTTP aberta esse tempo é derrubada por
 * proxy, por timeout de serverless e pela aba do usuário — as três coisas
 * deixando o trabalho órfão no meio.
 *
 * O corpo do `POST` carrega no máximo `force`. Tudo o que identifica o alvo —
 * empresa, matrícula, nome, vínculo externo — é montado no servidor a partir do
 * `employeeId` (§17, §58). Aceitar termo de busca do cliente entregaria a ele
 * uma consulta livre dentro do Tangerino da empresa.
 */

function publicConsultation(row: ConsultationRow | null | undefined) {
  if (!row) return null;
  const normalizedStatus = row.normalized_status as AdmissionStatus;
  return {
    id: row.id,
    state: row.state,
    source: "BROWSER" as const,
    errorCode: row.error_code,
    // O texto original acompanha a tradução em toda resposta (§30). Quando a
    // tradução for `UNKNOWN`, é ele que a tela mostra — e é dele que sai a
    // evidência para completar o mapa de status.
    rawStatus: row.raw_status,
    normalizedStatus,
    statusLabel: admissionStatusLabels[normalizedStatus] ?? admissionStatusLabels.UNKNOWN,
    stage: row.stage,
    pendingReason: row.pending_reason,
    admissionDate: row.admission_date,
    sourceUpdatedAt: row.source_updated_at,
    externalAdmissionId: row.external_admission_id,
    matchCount: row.match_count,
    requestedAt: row.requested_at,
    consultedAt: row.consulted_at,
    durationMs: row.duration_ms,
  };
}

export async function POST(request: Request, { params }: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { employeeId } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "integrations.tangerino.admission.read");
    await requireTangerinoAgent(d1, workspace.id);

    const target = await loadConsultationTarget(d1, workspace.id, employeeId);
    /* O acesso por empresa vem depois de carregar o alvo, e não antes: é o
       cadastro que diz de qual empresa o colaborador é. Um usuário restrito a
       duas das cinco empresas do grupo não consulta a admissão da terceira. */
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, target.companyId);

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const result = await enqueueConsultation(d1, {
      target,
      requestedByUserId: user.id,
      force: body.force === true,
    });

    if (result.outcome === "queued") {
      await prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "tangerino.consultation.requested", entityType: "employee", entityId: employeeId,
        after: { consultationId: result.consultation.id, forced: body.force === true },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }).run();
      await wakeTangerinoWorker({ workspaceId: workspace.id, userId: user.id });
    }

    return Response.json({
      outcome: result.outcome,
      consultation: publicConsultation(result.consultation),
    }, { status: result.outcome === "queued" ? 202 : 200 });
  } catch (error) {
    return apiError(error);
  }
}

export async function GET(_request: Request, { params }: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { employeeId } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "integrations.tangerino.admission.read");

    const target = await loadConsultationTarget(d1, workspace.id, employeeId);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, target.companyId);

    /* O `GET` não passa por `requireTangerinoAgent`: com o módulo desligado, o
       histórico já registrado continua sendo do grupo e continua legível. Só o
       `POST` — que abre navegador — depende do agente estar ligado. */
    const [current, history] = await Promise.all([
      lastConsultation(d1, workspace.id, employeeId),
      consultationHistory(d1, workspace.id, employeeId),
    ]);

    return Response.json({
      employeeId,
      externalAdmissionId: target.externalAdmissionId,
      current: publicConsultation(current),
      history: history.map(publicConsultation),
    });
  } catch (error) {
    return apiError(error);
  }
}
