import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { assertNoClinicalData } from "@/lib/auxiliary";
import { cleanText, optionalDate } from "@/lib/registrations";
import { calculateSessionTotal, paymentEnum, positiveMoney, psychologySessionOrigins, quantity } from "@/lib/payments";
import { requireOpenCycle, requireProvider } from "@/lib/payment-service";

/**
 * Lançamento de consulta para pagamento.
 *
 * Guarda somente: colaborador, empresa, psicólogo, data, competência,
 * quantidade, valor unitário e total. Nada de diagnóstico, motivo,
 * evolução ou qualquer conteúdo clínico.
 */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "psychology.payments.read");
    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    const cycleId = cleanText(url.searchParams.get("competenceId"), 120);
    const providerId = cleanText(url.searchParams.get("psychologistId"), 120);
    const cursor = cleanText(url.searchParams.get("cursor"), 120);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);

    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    if (!access.unrestricted && access.companyIds.size === 0) return Response.json({ sessions: [], nextCursor: null });
    const where = ["s.workspace_id = ?"];
    const values: unknown[] = [workspace.id];
    if (!access.unrestricted) {
      const ids = [...access.companyIds];
      where.push(`s.company_id IN (${ids.map(() => "?").join(",")})`);
      values.push(...ids);
    }
    if (companyId) { where.push("s.company_id = ?"); values.push(companyId); }
    if (cycleId) { where.push("s.payroll_cycle_id = ?"); values.push(cycleId); }
    if (providerId) { where.push("s.provider_id = ?"); values.push(providerId); }
    if (cursor) { where.push("s.id > ?"); values.push(cursor); }

    const result = await d1.prepare(`SELECT s.id, s.company_id, s.provider_id, s.employee_id, s.payroll_cycle_id, s.closing_id, s.competence,
        s.session_date, s.session_quantity, s.unit_amount, s.total_amount, s.origin, s.status, s.administrative_note, s.created_at,
        e.full_name AS employee_name, e.registration_number, a.legal_name AS psychologist_name
      FROM fdp_psychology_sessions s
      JOIN fdp_employees e ON e.workspace_id = s.workspace_id AND e.id = s.employee_id
      JOIN fdp_auxiliary_providers a ON a.workspace_id = s.workspace_id AND a.id = s.provider_id
      WHERE ${where.join(" AND ")} ORDER BY s.id LIMIT ?`).bind(...values, limit + 1).all<Record<string, unknown>>();
    const rows = result.results.slice(0, limit);
    return Response.json({ sessions: rows, nextCursor: result.results.length > limit ? String(rows.at(-1)?.id) : null });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "psychology.payments.manage");

    const companyId = cleanText(body.companyId, 120);
    const cycleId = cleanText(body.competenceId ?? body.payrollCycleId, 120);
    const providerId = cleanText(body.psychologistId ?? body.providerId, 120);
    const employeeId = cleanText(body.employeeId, 120);
    if (!companyId || !cycleId || !providerId || !employeeId) {
      throw ApiError.badRequest("Empresa, competência, psicólogo e colaborador são obrigatórios.", "PSYCHOLOGY_SESSION_REQUIRED_FIELDS");
    }
    const note = cleanText(body.administrativeNote, 300);
    assertNoClinicalData("psychology", note);

    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const cycle = await requireOpenCycle(d1, workspace.id, companyId, cycleId);
    await requireProvider(d1, workspace.id, providerId, "psychologist");

    const [employee, profile] = await Promise.all([
      d1.prepare("SELECT id FROM fdp_employees WHERE workspace_id = ? AND company_id = ? AND id = ?").bind(workspace.id, companyId, employeeId).first(),
      d1.prepare("SELECT default_session_amount, status FROM fdp_psychologist_profiles WHERE workspace_id = ? AND provider_id = ?")
        .bind(workspace.id, providerId).first<{ default_session_amount: string | number; status: string }>(),
    ]);
    if (!employee) throw ApiError.badRequest("Colaborador inválido para esta empresa.", "INVALID_EMPLOYEE");
    if (!profile || profile.status !== "active") throw ApiError.badRequest("O psicólogo não possui cadastro financeiro ativo.", "PSYCHOLOGIST_NOT_CONFIGURED");

    const sessionQuantity = quantity(body.quantity ?? 1, "Quantidade de consultas");
    // O valor unitário informado é congelado no lançamento; alterar a tabela do
    // psicólogo depois não muda consultas já registradas.
    const unitAmount = positiveMoney(
      body.unitAmount === undefined || body.unitAmount === null || body.unitAmount === "" ? profile.default_session_amount : body.unitAmount,
      "Valor unitário da consulta",
    );
    if (unitAmount <= 0) throw ApiError.badRequest("Informe o valor da consulta ou configure o valor padrão do psicólogo.", "SESSION_AMOUNT_REQUIRED");
    const totalAmount = calculateSessionTotal(sessionQuantity, unitAmount);
    const sessionDate = optionalDate(body.sessionDate, true);
    const origin = paymentEnum(body.origin, psychologySessionOrigins, "manual");
    const id = crypto.randomUUID();

    // Um fechamento já concluído não recebe novas consultas na mesma competência.
    const closing = await d1.prepare("SELECT id, status FROM fdp_psychology_closings WHERE workspace_id = ? AND provider_id = ? AND payroll_cycle_id = ?")
      .bind(workspace.id, providerId, cycleId).first<{ id: string; status: string }>();
    if (closing && (closing.status === "closed" || closing.status === "paid")) {
      throw ApiError.badRequest("O fechamento desta competência está concluído. Reabra com justificativa para lançar consultas.", "PAYMENT_CLOSING_LOCKED");
    }

    await d1.batch([
      d1.prepare(`INSERT INTO fdp_psychology_sessions (id, workspace_id, company_id, provider_id, employee_id, payroll_cycle_id, closing_id,
          competence, session_date, session_quantity, unit_amount, total_amount, origin, status, administrative_note, external_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'registered', ?, ?, ?)`)
        .bind(id, workspace.id, companyId, providerId, employeeId, cycleId, closing?.id ?? null, cycle.competence, sessionDate,
          sessionQuantity, unitAmount, totalAmount, origin, note, cleanText(body.externalId, 160), user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "psychology_session.created", entityType: "psychology_session", entityId: id,
        after: { companyId, providerId, employeeId, competence: cycle.competence, sessionQuantity, unitAmount, totalAmount, origin },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ session: { id, competence: cycle.competence, sessionQuantity, unitAmount, totalAmount, status: "registered" } }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
