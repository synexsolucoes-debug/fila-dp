import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { cleanText } from "@/lib/clean-text";
import { parseWorkAccidentInput, workAccidentFromRow } from "@/lib/work-accidents-service";

/** Teto de uma consulta. Acima dele a tela avisa que o recorte precisa ser menor. */
const MAX_RECORDS = 5000;

/**
 * Anos pedidos no endereço, como condição de intervalo.
 *
 * `EXTRACT(YEAR FROM occurred_on) = ?` descarta o índice por data e obriga a
 * varredura da tabela inteira; dois intervalos por ano fazem a mesma pergunta
 * usando o índice que a migration criou.
 */
function yearConditions(values: string[]) {
  const years = [...new Set(values.map((value) => Number(value)).filter((year) => Number.isInteger(year) && year >= 1900 && year <= 2999))];
  if (!years.length) return null;
  return {
    sql: `(${years.map(() => "(accident.occurred_on >= ? AND accident.occurred_on < ?)").join(" OR ")})`,
    binds: years.flatMap((year) => [`${year}-01-01`, `${year + 1}-01-01`]),
  };
}

/**
 * Os acidentes do recorte, crus.
 *
 * A apuração dos nove gráficos acontece em `lib/work-accidents.ts`, com a mesma
 * função nos dois lados. Devolver os registros e agregar na tela é o que
 * permite trocar de mês sem nova ida ao banco — e o volume comporta: um SESMT
 * que lançasse um acidente por dia útil levaria vinte anos para encostar no
 * teto desta consulta.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "safety.view", "consultar os acidentes de trabalho");
    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);

    const conditions = ["accident.workspace_id = ?"]; const values: unknown[] = [workspace.id];
    if (!access.unrestricted) {
      const ids = [...access.companyIds];
      if (ids.length) { conditions.push(`accident.company_id IN (${ids.map(() => "?").join(",")})`); values.push(...ids); }
      else conditions.push("false");
    }
    if (companyId) { conditions.push("accident.company_id = ?"); values.push(companyId); }
    const years = yearConditions(url.searchParams.getAll("year"));
    if (years) { conditions.push(years.sql); values.push(...years.binds); }

    const result = await d1.prepare(`SELECT accident.*,
        COALESCE(NULLIF(company.trade_name, ''), company.legal_name) AS company_name
      FROM fdp_work_accidents accident
      JOIN fdp_companies company
        ON company.workspace_id = accident.workspace_id AND company.id = accident.company_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY accident.occurred_on DESC, accident.id DESC
      LIMIT ?`).bind(...values, MAX_RECORDS + 1).all<Record<string, unknown>>();

    const rows = result.results.slice(0, MAX_RECORDS);
    return Response.json({
      accidents: rows.map(workAccidentFromRow),
      truncated: result.results.length > MAX_RECORDS,
      limit: MAX_RECORDS,
    });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "safety.manage", "registrar um acidente de trabalho");
    const input = parseWorkAccidentInput(body);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, input.companyId);

    const id = crypto.randomUUID();
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_work_accidents
        (id, workspace_id, company_id, occurred_on, accident_type, body_part, sector, work_shift, gender,
         employee_label, leave_days, expense_amount, cat_issued, cat_number, description, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, workspace.id, input.companyId, input.occurredOn, input.accidentType, input.bodyPart,
          input.sector, input.workShift, input.gender, input.employeeLabel, input.leaveDays,
          input.expenseAmount, input.catIssued ? 1 : 0, input.catNumber, input.description, user.id, user.id),
      /* O nome do colaborador e a descrição do acidente ficam fora da trilha:
         ela guarda o que mudou no número, não o relato de saúde de uma pessoa
         identificada. Quem precisa do caso abre o registro, onde a permissão
         do módulo vale. */
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "work_accident.created", entityType: "work_accident", entityId: id,
        after: {
          companyId: input.companyId, occurredOn: input.occurredOn, accidentType: input.accidentType,
          bodyPart: input.bodyPart, sector: input.sector, workShift: input.workShift,
          leaveDays: input.leaveDays, expenseAmount: input.expenseAmount, catIssued: input.catIssued,
        },
        metadata: { scope: "company", companyId: input.companyId },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ accident: { id, ...input } }, { status: 201 });
  } catch (error) { return apiError(error); }
}
