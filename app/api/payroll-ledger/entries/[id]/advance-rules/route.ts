import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { parseAdvanceRuleInput } from "@/lib/payroll-ledger-service";

/**
 * A regra de um adiantamento, versionada por vigência.
 *
 * Alterar o valor de um vale fixo **não** reescreve a linha: cria outra, com a
 * competência em que passa a valer, e marca a anterior como `superseded`. As
 * competências já processadas continuam lendo a regra que valia nelas — que é a
 * diferença entre corrigir um valor e reescrever o histórico.
 *
 * Percentual sem base salarial é aceito e nasce com pendência nomeada. O
 * produto não guarda salário (ver `fdp_employees`), e recusar a regra obrigaria
 * o DP a inventar um valor fixo para registrar o que na prática é um
 * percentual. O que ele não faz é calcular sobre zero: a competência aparece na
 * conferência como pendência, não como um pagamento de R$ 0,00 que ninguém
 * notaria.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "ledger.read", "consultar as regras de adiantamento");

    const entry = await d1.prepare(`SELECT id, company_id, category, modality FROM fdp_ledger_entries
      WHERE workspace_id = ? AND id = ?`).bind(workspace.id, id).first<Record<string, unknown>>();
    if (!entry) throw ApiError.notFound("Lançamento não encontrado.", "LEDGER_ENTRY_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(entry.company_id));

    const rules = await d1.prepare(`SELECT rule.*, member.name AS created_by_name
      FROM fdp_ledger_advance_rules rule
      LEFT JOIN fdp_users member ON member.id = rule.created_by
      WHERE rule.workspace_id = ? AND rule.entry_id = ?
      ORDER BY rule.effective_from_competence DESC`).bind(workspace.id, id).all<Record<string, unknown>>();

    return Response.json({ rules: rules.results });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "ledger.manage", "definir a regra de um adiantamento");

    const entry = await d1.prepare(`SELECT id, company_id, category, status, first_competence
      FROM fdp_ledger_entries WHERE workspace_id = ? AND id = ?`)
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (!entry) throw ApiError.notFound("Lançamento não encontrado.", "LEDGER_ENTRY_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(entry.company_id));
    if (String(entry.category) !== "salary_advance") {
      throw ApiError.badRequest("Regra de adiantamento só existe em lançamento da categoria adiantamento salarial.", "LEDGER_NOT_ADVANCE");
    }

    const input = parseAdvanceRuleInput(body);

    /* A vigência nova não pode começar antes da regra que já está valendo:
       seria reescrever competências que já leram a anterior. */
    const vigente = await d1.prepare(`SELECT id, effective_from_competence FROM fdp_ledger_advance_rules
      WHERE workspace_id = ? AND entry_id = ? AND status <> 'canceled'
      ORDER BY effective_from_competence DESC LIMIT 1`)
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (vigente && String(vigente.effective_from_competence) >= input.effectiveFromCompetence) {
      throw ApiError.badRequest(
        `Já existe uma regra vigente a partir de ${String(vigente.effective_from_competence)}. Uma alteração vale para uma competência posterior.`,
        "LEDGER_RULE_NOT_FUTURE",
      );
    }

    const ruleId = crypto.randomUUID();
    const requestId = request.headers.get("x-fila-dp-request-id");

    await d1.batch([
      d1.prepare(`INSERT INTO fdp_ledger_advance_rules
        (id, workspace_id, entry_id, mode, fixed_amount, percentage, salary_base_amount, salary_base_source,
         effective_from_competence, end_competence, supersedes_rule_id, status, note, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
        .bind(ruleId, workspace.id, id, input.mode, input.fixedAmount, input.percentage,
          input.salaryBaseAmount, input.salaryBaseSource, input.effectiveFromCompetence,
          input.endCompetence, vigente ? String(vigente.id) : null, input.note, user.id),
      /* A anterior vira `superseded`, e não some: as competências anteriores à
         nova vigência continuam lendo o valor que valia nelas. */
      ...(vigente ? [d1.prepare(`UPDATE fdp_ledger_advance_rules SET status = 'superseded'
        WHERE workspace_id = ? AND id = ? AND status = 'active'`)
        .bind(workspace.id, String(vigente.id))] : []),
      d1.prepare(`INSERT INTO fdp_ledger_events (id, workspace_id, entry_id, event_type, summary, payload_json, actor_user_id)
        VALUES (?, ?, ?, 'updated', ?, ?::jsonb, ?)`)
        .bind(crypto.randomUUID(), workspace.id, id,
          `Regra de adiantamento a partir de ${input.effectiveFromCompetence}`,
          JSON.stringify({
            mode: input.mode, fixedAmount: input.fixedAmount, percentage: input.percentage,
            effectiveFrom: input.effectiveFromCompetence, pendingReason: input.pendingReason,
          }), user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "ledger_advance_rule.created", entityType: "ledger_entry", entityId: id,
        after: { ruleId, mode: input.mode, effectiveFrom: input.effectiveFromCompetence },
        metadata: { supersedes: vigente ? String(vigente.id) : null, pendingReason: input.pendingReason },
        requestId,
      }),
    ]);

    return Response.json({
      rule: { id: ruleId, ...input, status: "active", entryId: id },
      /* A pendência vai na resposta para a tela poder mostrá-la agora, em vez
         de a pessoa descobrir na conferência do mês que vem. */
      pendingReason: input.pendingReason,
    }, { status: 201 });
  } catch (error) { return apiError(error); }
}
