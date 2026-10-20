import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import {
  MAX_MOVEMENTS_PER_REQUEST, checkMovement, hasBlock, parseCompetence, parseDecimalInput, roundIndex, toCents,
} from "@/lib/payroll-movements";
import { listCompanyMovements, loadCompany, loadCompanyEmployees, loadEventCatalog } from "@/lib/payroll-movements-service";

/**
 * Movimentos para o Sankhya: os lançamentos de uma empresa numa competência.
 *
 * GET devolve tudo que a tela precisa de uma vez — lançamentos já conferidos,
 * colaboradores da empresa e o catálogo de eventos. POST grava um lote (um
 * lançamento do formulário ou várias linhas coladas do Excel): ou entra o lote
 * inteiro, ou nada, com a lista do que impediu. Gravar metade de uma colagem
 * deixaria a pessoa sem saber quais linhas ficaram de fora.
 */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const url = new URL(request.url);
    const companyId = text(url.searchParams.get("companyId"), 120);
    const competence = parseCompetence(url.searchParams.get("competence"));
    if (!companyId || !competence) throw ApiError.badRequest("Informe a empresa e a competência (AAAA-MM).", "PAYROLL_MOVEMENT_SCOPE");
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "hr.read");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const company = await loadCompany(d1, workspace.id, companyId);
    if (!company) throw ApiError.notFound("Empresa não encontrada neste workspace.", "COMPANY_NOT_FOUND");

    const catalog = await loadEventCatalog(d1, workspace.id);
    const employees = await loadCompanyEmployees(d1, workspace.id, companyId);
    const movements = await listCompanyMovements(d1, { workspaceId: workspace.id, companyId, competence, events: catalog.events });
    return Response.json({
      company,
      competence,
      catalog: { count: catalog.events.size, updatedAt: catalog.updatedAt },
      events: [...catalog.events.values()],
      employees,
      movements,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

type IncomingEntry = { employeeId?: unknown; employeeCode?: unknown; eventCode?: unknown; index?: unknown; amount?: unknown; note?: unknown; line?: unknown };

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const companyId = text(body.companyId, 120);
    const competence = parseCompetence(body.competence);
    const entries = Array.isArray(body.entries) ? body.entries as IncomingEntry[] : [];
    if (!companyId || !competence) throw ApiError.badRequest("Informe a empresa e a competência (AAAA-MM).", "PAYROLL_MOVEMENT_SCOPE");
    if (!entries.length) throw ApiError.badRequest("Nenhum lançamento enviado.", "PAYROLL_MOVEMENT_EMPTY");
    if (entries.length > MAX_MOVEMENTS_PER_REQUEST) {
      throw ApiError.badRequest(`Envie no máximo ${MAX_MOVEMENTS_PER_REQUEST} lançamentos por vez.`, "PAYROLL_MOVEMENT_TOO_MANY");
    }

    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "hr.write");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const company = await loadCompany(d1, workspace.id, companyId);
    if (!company) throw ApiError.notFound("Empresa não encontrada neste workspace.", "COMPANY_NOT_FOUND");

    const catalog = await loadEventCatalog(d1, workspace.id);
    if (!catalog.events.size) {
      throw ApiError.badRequest("Importe o catálogo de eventos (TFPEVE) do Sankhya antes de lançar.", "PAYROLL_EVENT_CATALOG_EMPTY");
    }
    const employees = await loadCompanyEmployees(d1, workspace.id, companyId);
    const byId = new Map(employees.map((employee) => [employee.id, employee]));
    const byCode = new Map(employees.filter((employee) => employee.code).map((employee) => [employee.code, employee]));

    const problems: Array<{ line: number; message: string }> = [];
    const rows: Array<{ employeeId: string; eventCode: number; indexValue: number; amountCents: number; note: string }> = [];
    entries.forEach((entry, position) => {
      const line = Number(entry.line) > 0 ? Number(entry.line) : position + 1;
      const employeeId = text(entry.employeeId, 120);
      const employeeCode = text(String(entry.employeeCode ?? ""), 20).replace(/^0+(?=\d)/u, "");
      const employee = employeeId ? byId.get(employeeId) : byCode.get(employeeCode);
      const eventCode = Number(entry.eventCode);
      const index = parseDecimalInput(entry.index);
      const amount = parseDecimalInput(entry.amount);
      if (!Number.isInteger(eventCode) || eventCode <= 0) { problems.push({ line, message: "Código do evento inválido." }); return; }
      if (index === null || amount === null) { problems.push({ line, message: "Índice ou valor com formato inválido. Use 12,5 ou 2:30 para horas." }); return; }
      if (!employee) {
        problems.push({ line, message: employeeCode ? `Colaborador ${employeeCode} não encontrado nesta empresa.` : "Escolha o colaborador." });
        return;
      }
      const indexValue = roundIndex(index);
      const amountCents = toCents(amount);
      const checks = checkMovement({ competence, indexValue, amountCents, event: catalog.events.get(eventCode), employee });
      for (const check of checks) if (check.level === "block") problems.push({ line, message: `${employee.name}: ${check.message}` });
      if (!hasBlock(checks)) rows.push({ employeeId: employee.id, eventCode, indexValue, amountCents, note: text(entry.note, 300) });
    });
    if (problems.length) {
      throw new ApiError(400, "PAYROLL_MOVEMENT_INVALID",
        problems.length === 1 ? problems[0].message : `${problems.length} problema(s) impediram o lançamento. Nada foi gravado.`,
        { problems: problems.slice(0, 50) });
    }

    await d1.batch(rows.map((row) => d1.prepare(`INSERT INTO fdp_payroll_movement_entries
      (id, workspace_id, company_id, employee_id, competence, event_code, index_value, amount_cents, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), workspace.id, companyId, row.employeeId, competence, row.eventCode,
        row.indexValue, row.amountCents, row.note, user.id)));

    /* A trilha registra quem lançou, onde e quantos. Nome e valor ficam no
       módulo, onde a permissão vale. */
    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "payroll_movements.created", entityType: "payroll_movements", entityId: companyId,
      after: { competence, rows: rows.length },
      metadata: { companyId },
    }).run();

    return Response.json({ created: rows.length }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
