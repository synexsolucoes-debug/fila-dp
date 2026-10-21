import { getScopedD1 } from "@/db";
import { apiError } from "@/lib/fila-dp-api";
import { prepareAuditEvent } from "@/lib/fila-dp-db";
import { ApiError } from "@/lib/api-errors";
import { clientAddress, consumePublicAuthRateLimit } from "@/lib/auth-rate-limit";
import { assertEmployeePortalLinkUsable, employeePortalLinkStatus, hashPortalToken, parsePortalToken, portalInstant, type PortalLink } from "@/lib/employee-portal";
import { samePortalHash } from "@/lib/contractor-invoice-portal";
import { todayInBrazil } from "@/lib/employee-history";
import { vacationPeriods } from "@/lib/vacation-balance";
import { prepareSchedule, schedulesOf } from "@/lib/vacation-service";

type Params = { params: Promise<{ token: string }> };

/**
 * Portal do colaborador (§4.42): os holerites das folhas fechadas, as férias
 * e o pedido de férias, sem conta e sem senha. Mesmo desenho dos portais do
 * prestador e de EPI — o inquilino vem do token, a conexão nasce presa a ele,
 * toda recusa é o mesmo 404, e a resposta carrega só o que é da própria pessoa.
 */

const genericNotFound = () => ApiError.notFound("Este link não é válido. Confira o endereço recebido ou procure o DP.", "EMPLOYEE_PORTAL_NOT_FOUND");
const day = (value: unknown) => value ? (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10) : "";

async function resolveLink(rawToken: string, request: Request) {
  const parsed = parsePortalToken(rawToken);
  if (!parsed) throw genericNotFound();
  const limite = await consumePublicAuthRateLimit("employee_portal", parsed.secret.slice(0, 32), clientAddress(request));
  if (!limite.allowed) {
    throw new ApiError(429, "EMPLOYEE_PORTAL_RATE_LIMITED", "Muitas tentativas neste link. Aguarde alguns minutos e tente de novo.",
      { retryAfterSeconds: limite.retryAfterSeconds });
  }
  const hash = hashPortalToken(parsed.workspaceId, parsed.secret);
  const d1 = getScopedD1({ workspaceId: parsed.workspaceId });
  const link = await d1.prepare(`SELECT link.id, link.workspace_id, link.company_id, link.employee_id, link.token_hash, link.expires_at, link.revoked_at,
      COALESCE(NULLIF(e.social_name, ''), e.full_name) AS employee_name, e.registration_number, e.admission_date, e.termination_date,
      e.employment_status, e.employment_type, COALESCE(NULLIF(c.trade_name, ''), c.legal_name) AS company_name
    FROM fdp_employee_portal_links link
    JOIN fdp_employees e ON e.workspace_id = link.workspace_id AND e.id = link.employee_id
    JOIN fdp_companies c ON c.workspace_id = link.workspace_id AND c.id = link.company_id
    WHERE link.workspace_id = ? AND link.token_hash = ?`).bind(parsed.workspaceId, hash).first<PortalLink>();
  if (!link || !samePortalHash(link.token_hash, hash)) throw genericNotFound();
  return { d1, link };
}

async function portalPayload(d1: ReturnType<typeof getScopedD1>, link: PortalLink) {
  const payslips = await d1.prepare(`SELECT u.id AS run_id, r.competence, r.net_cents, r.earnings_cents, r.deductions_cents
      FROM fdp_payroll_results r JOIN fdp_payroll_runs u ON u.workspace_id = r.workspace_id AND u.id = r.run_id
      WHERE r.workspace_id = ? AND r.employee_id = ? AND u.status = 'closed' ORDER BY r.competence DESC LIMIT 24`)
    .bind(link.workspace_id, link.employee_id).all<Record<string, unknown>>();
  const schedules = await schedulesOf(d1, link.workspace_id, [link.employee_id]);
  const today = todayInBrazil();
  return {
    employeeName: link.employee_name, registrationNumber: link.registration_number, companyName: link.company_name,
    expiresAt: portalInstant(link.expires_at), today,
    payslips: (payslips.results ?? []).map((row) => ({
      runId: String(row.run_id), competence: String(row.competence), netCents: Number(row.net_cents),
      earningsCents: Number(row.earnings_cents), deductionsCents: Number(row.deductions_cents),
    })),
    periods: vacationPeriods(day(link.admission_date), today, schedules, day(link.termination_date) || null),
    schedules: schedules.map(({ id, acquisitiveStart, startDate, restDays, soldDays, status }) => ({ id, acquisitiveStart, startDate, restDays, soldDays, status })),
  };
}

export async function GET(request: Request, { params }: Params) {
  try {
    const { token } = await params;
    const { d1, link } = await resolveLink(token, request);
    const status = employeePortalLinkStatus(link);
    if (status !== "active") return Response.json({ status }, { headers: { "Cache-Control": "no-store" } });
    await d1.prepare(`UPDATE fdp_employee_portal_links SET opened_count = opened_count + 1, first_opened_at = COALESCE(first_opened_at, now()),
        last_opened_at = now(), updated_at = now() WHERE workspace_id = ? AND id = ?`).bind(link.workspace_id, link.id).run();
    return Response.json({ status, portal: await portalPayload(d1, link) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}

/** Pedido de férias: entra como programação para o DP aprovar, com as regras da CLT. */
export async function POST(request: Request, { params }: Params) {
  try {
    const { token } = await params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const { d1, link } = await resolveLink(token, request);
    assertEmployeePortalLinkUsable(link);
    if (link.employment_type === "intern") throw ApiError.badRequest("Estagiário combina o recesso diretamente com o DP.", "PORTAL_VACATION_INTERN");
    const existing = await schedulesOf(d1, link.workspace_id, [link.employee_id]);
    const planned = prepareSchedule(d1, {
      workspaceId: link.workspace_id, companyId: link.company_id, employeeId: link.employee_id, admissionDate: day(link.admission_date),
      today: todayInBrazil(), userId: "employee_portal", existing,
      body: { startDate: body.startDate, restDays: Number(body.restDays), soldDays: Number(body.soldDays ?? 0), notes: "Pedido pelo colaborador no portal" },
    });
    await d1.batch([planned.statement, prepareAuditEvent({
      workspaceId: link.workspace_id, actorType: "system", actorEmail: link.employee_name,
      action: "employee.vacation.requested", entityType: "employee", entityId: link.employee_id,
      after: { scheduleId: planned.id, startDate: body.startDate, restDays: body.restDays, soldDays: body.soldDays ?? 0 },
      metadata: { via: "employee_portal", portalLinkId: link.id, scope: "company", companyId: link.company_id },
      requestId: request.headers.get("x-fila-dp-request-id"),
    })]);
    return Response.json({ requested: { end: planned.end, returnDate: planned.returnDate, warnings: planned.warnings }, portal: await portalPayload(d1, link) },
      { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
