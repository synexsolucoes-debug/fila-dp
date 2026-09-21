import { requireCapability } from "@/lib/authorization";
import { ApiError, apiError, getApiUser } from "@/lib/fila-dp-api";
import {
  getWorkspaceContext, prepareAuditEvent, recordActivity, requireCardCompanyAccess, requireWorkspaceRole,
} from "@/lib/fila-dp-db";

type RouteContext = { params: Promise<{ id: string }> };

/** Janela padrão entre concluir e apagar a ficha. Configurável por grupo. */
const DEFAULT_RETENTION_DAYS = 30;

/**
 * O DP confirma que cadastrou no Sankhya.
 *
 * ## Por que a conclusão depende de uma pessoa
 *
 * Baixar o documento, extrair os campos e copiar para a área de transferência
 * não provam cadastro nenhum. A área de transferência não sabe se o operador
 * colou, se o ERP aceitou, nem se a tela foi salva. Concluir automaticamente
 * por qualquer um desses sinais marcaria como pronta uma admissão que não
 * existe no ERP — e o erro só apareceria na folha.
 *
 * Quem sabe é quem cadastrou, e o que registra isso é a matrícula que o
 * Sankhya devolveu. O banco cobra os dois: `confirmed_at` sem matrícula e sem
 * responsável é recusado por CHECK, porque uma confirmação que ninguém
 * consegue conferir depois não vale como registro.
 *
 * ## Retenção, e por que ela substituiu o expurgo imediato
 *
 * A versão anterior apagava a ficha no instante da conclusão. Parecia
 * cuidadoso e era cedo demais: erro de digitação no ERP aparece no dia
 * seguinte, e a conferência ficava sem o material que a sustentaria — restava
 * reabrir sessão de navegador e baixar tudo de novo.
 *
 * Agora a conclusão marca uma data e o expurgo acontece quando ela chega. O
 * documento anexado segue a retenção de anexos da demanda, que é outra
 * política: o arquivo original e a transcrição estruturada têm vidas
 * diferentes, e tratá-los como um só obrigaria a escolher o pior prazo para
 * um dos dois.
 */
export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id: cardId } = await context.params;
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    requireCapability(workspace, "attachments.write");
    requireCapability(workspace, "admission.sheet.read");
    await requireCardCompanyAccess(d1, workspace.id, user.id, workspace.role, cardId);

    const card = await d1.prepare(`SELECT id FROM fdp_cards
      WHERE workspace_id = ? AND board_id = ? AND id = ? AND archived = 0`)
      .bind(workspace.id, board.id, cardId).first<{ id: string }>();
    if (!card) throw ApiError.notFound("Demanda não encontrada.", "CARD_NOT_FOUND");

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const registration = String(body.erpRegistration ?? "").trim().slice(0, 60);
    /* Matrícula é identificador de ERP: dígitos, letras e separadores simples.
       Recusar texto livre impede que a confirmação vire um campo de recado. */
    if (!/^[A-Za-z0-9./-]{1,60}$/u.test(registration)) {
      throw ApiError.badRequest(
        "Informe a matrícula ou o identificador que o Sankhya gerou para o colaborador.",
        "ERP_REGISTRATION_REQUIRED",
      );
    }

    const retentionDays = Math.min(365, Math.max(1, Number(body.retentionDays) || DEFAULT_RETENTION_DAYS));

    const confirmed = await d1.prepare(`UPDATE fdp_admission_sheets
      SET erp_registration = ?, confirmed_by = ?, confirmed_at = CURRENT_TIMESTAMP,
          retention_until = CURRENT_TIMESTAMP + (? || ' days')::interval,
          updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND card_id = ? AND state = 'ready' AND confirmed_at IS NULL
      RETURNING id`)
      .bind(registration, auth.user.email.slice(0, 220), String(retentionDays), workspace.id, cardId)
      .first<{ id: string }>();
    if (!confirmed) {
      throw new ApiError(409, "ADMISSION_SHEET_NOT_CONFIRMABLE",
        "Só uma ficha pronta e ainda não confirmada pode ser marcada como cadastrada no ERP.");
    }

    await d1.batch([
      prepareAuditEvent({
        workspaceId: workspace.id, actorType: "user", actorEmail: auth.user.email,
        action: "admission.sheet.confirmed", entityType: "card", entityId: cardId,
        after: { erpRegistration: registration, retentionDays },
      }),
    ]);
    await recordActivity(workspace.id, cardId, auth.user.email, "admission.sheet.confirmed", {
      erpRegistration: registration, retentionDays,
    });

    return Response.json({
      confirmed: true,
      erpRegistration: registration,
      retentionDays,
      detail: `Cadastro registrado com a matrícula ${registration}. A ficha fica disponível por ${retentionDays} dias para conferência e depois é apagada.`,
    }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
