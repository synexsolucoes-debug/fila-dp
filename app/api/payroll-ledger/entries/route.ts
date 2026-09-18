import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";
import { fromCents, ledgerCategories, ledgerEntryStatuses } from "@/lib/payroll-ledger";
import {
  MAX_LEDGER_RECORDS, ledgerEntryFromRow, parseLedgerEntryInput, plannedRowsFor,
} from "@/lib/payroll-ledger-service";

/**
 * O saldo de cada lançamento sai da mesma consulta que traz a lista.
 *
 * Pedir o saldo em uma ida a mais por linha seria o N+1 clássico: a tela abre
 * com 2000 lançamentos e faria 2001 consultas. O `LEFT JOIN LATERAL` resolve
 * tudo em uma.
 *
 * A apuração é a **mesma** de `ledgerBalance()` em `lib/payroll-ledger.ts`,
 * escrita duas vezes porque roda nos dois lados, e por isso
 * `tests/payroll-ledger-core.test.mts` confere que as duas concordam. Parcela
 * cancelada, pulada ou reprogramada sai do previsto; o que já foi descontado
 * nela continua contando, porque o dinheiro saiu.
 *
 * O trecho aparece escrito por extenso aqui e na rota do detalhe, e não como
 * constante compartilhada, porque `scripts/verify-inline-sql` prepara cada
 * consulta contra o schema real substituindo o trecho interpolado por **um**
 * candidato: duas interpolações na mesma consulta a tirariam da cobertura, que
 * é o contrário do que se quer numa consulta que decide dinheiro.
 *
 * Os filtros da lista — empresa, pessoa, categoria, situação, departamento e
 * área solicitante — são as perguntas que a planilha só respondia lendo aba
 * por aba.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "ledger.read", "consultar os adiantamentos e descontos");
    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);

    const conditions = ["entry.workspace_id = ?"]; const values: unknown[] = [workspace.id];
    if (!access.unrestricted) {
      const ids = [...access.companyIds];
      if (ids.length) { conditions.push(`entry.company_id IN (${ids.map(() => "?").join(",")})`); values.push(...ids); }
      else conditions.push("false");
    }
    if (companyId) { conditions.push("entry.company_id = ?"); values.push(companyId); }

    const employeeId = cleanText(url.searchParams.get("employeeId"), 120);
    if (employeeId) { conditions.push("entry.employee_id = ?"); values.push(employeeId); }
    const providerId = cleanText(url.searchParams.get("providerId"), 120);
    if (providerId) { conditions.push("entry.provider_id = ?"); values.push(providerId); }
    const category = cleanText(url.searchParams.get("category"), 40);
    if (ledgerCategories.includes(category as never)) { conditions.push("entry.category = ?"); values.push(category); }
    const status = cleanText(url.searchParams.get("status"), 40);
    if (ledgerEntryStatuses.includes(status as never)) { conditions.push("entry.status = ?"); values.push(status); }
    const departmentId = cleanText(url.searchParams.get("departmentId"), 120);
    if (departmentId) { conditions.push("entry.department_id = ?"); values.push(departmentId); }
    const requesterAreaId = cleanText(url.searchParams.get("requesterAreaId"), 120);
    if (requesterAreaId) { conditions.push("entry.requester_area_id = ?"); values.push(requesterAreaId); }

    /* "Tem saldo" é a pergunta mais feita da tela, e ela não é um campo: é a
       comparação entre o previsto e o confirmado. Por isso o filtro lê a saída
       da apuração lateral, e não uma coluna guardada. */
    const openOnly = url.searchParams.get("open") === "true";
    if (openOnly) conditions.push("COALESCE(balance.open_installments, 0) > 0");

    const result = await d1.prepare(`SELECT entry.*,
        COALESCE(NULLIF(company.trade_name, ''), company.legal_name) AS company_name,
        employee.full_name AS employee_name, employee.registration_number,
        employee.employment_status, employee.termination_date,
        provider.legal_name AS provider_name,
        department.name AS department_name,
        area.name AS requester_area_name,
        COALESCE(balance.planned_total, 0) AS planned_total,
        COALESCE(balance.discounted_total, 0) AS discounted_total,
        COALESCE(balance.open_installments, 0) AS open_installments
      FROM fdp_ledger_entries entry
      JOIN fdp_companies company
        ON company.workspace_id = entry.workspace_id AND company.id = entry.company_id
      LEFT JOIN fdp_employees employee
        ON employee.workspace_id = entry.workspace_id AND employee.id = entry.employee_id
      LEFT JOIN fdp_auxiliary_providers provider
        ON provider.workspace_id = entry.workspace_id AND provider.id = entry.provider_id
      LEFT JOIN fdp_departments department
        ON department.workspace_id = entry.workspace_id AND department.id = entry.department_id
      LEFT JOIN fdp_areas area
        ON area.workspace_id = entry.workspace_id AND area.id = entry.requester_area_id
      LEFT JOIN LATERAL (
        SELECT
          SUM(CASE WHEN installment.status IN ('canceled', 'rescheduled', 'skipped')
            THEN installment.discounted_amount ELSE installment.planned_amount END) AS planned_total,
          SUM(installment.discounted_amount) AS discounted_total,
          COUNT(*) FILTER (WHERE installment.status NOT IN ('canceled', 'rescheduled', 'skipped')
            AND installment.discounted_amount < installment.planned_amount) AS open_installments
        FROM fdp_ledger_installments installment
        WHERE installment.workspace_id = entry.workspace_id AND installment.entry_id = entry.id
      ) balance ON true
      WHERE ${conditions.join(" AND ")}
      ORDER BY entry.created_at DESC, entry.id DESC
      LIMIT ?`).bind(...values, MAX_LEDGER_RECORDS + 1).all<Record<string, unknown>>();

    const rows = result.results.slice(0, MAX_LEDGER_RECORDS);
    return Response.json({
      entries: rows.map(ledgerEntryFromRow),
      truncated: result.results.length > MAX_LEDGER_RECORDS,
      limit: MAX_LEDGER_RECORDS,
    });
  } catch (error) { return apiError(error); }
}

/**
 * Um lançamento novo, com a programação de parcelas já calculada.
 *
 * O lançamento nasce como rascunho e as parcelas nascem com ele. A alternativa
 * — gerar as parcelas só na aprovação — deixaria quem aprova decidindo sobre um
 * valor total sem ver como ele se divide, que é exatamente a informação que a
 * pessoa descontada vai conferir depois.
 *
 * Nenhuma parcela nasce confirmada. Programar não é descontar.
 */
export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "ledger.manage", "criar um lançamento de desconto ou adiantamento");
    const input = parseLedgerEntryInput(body);
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, input.companyId);

    /* O vínculo é conferido contra a empresa, e não só contra o workspace: sem
       isto, um lançamento poderia nascer apontando para o colaborador de outra
       empresa do mesmo grupo — e a chave estrangeira composta recusaria com uma
       mensagem que ninguém entende. */
    let employmentTypeSnapshot = "";
    let departmentLabel = input.departmentLabel;
    let departmentId = input.departmentId;
    if (input.employeeId) {
      const employee = await d1.prepare(`SELECT employee.id, employee.employment_type, employee.department_id,
          department.name AS department_name
        FROM fdp_employees employee
        LEFT JOIN fdp_departments department
          ON department.workspace_id = employee.workspace_id AND department.id = employee.department_id
        WHERE employee.workspace_id = ? AND employee.company_id = ? AND employee.id = ?`)
        .bind(workspace.id, input.companyId, input.employeeId).first<Record<string, unknown>>();
      if (!employee) throw ApiError.badRequest("O colaborador não pertence à empresa selecionada.", "LEDGER_EMPLOYEE_MISMATCH");
      /* Fotografia do vínculo e do departamento. Mudar de empresa ou de área
         depois não pode reescrever o que este lançamento registrou. */
      employmentTypeSnapshot = String(employee.employment_type ?? "");
      if (!departmentId) departmentId = employee.department_id ? String(employee.department_id) : null;
      if (!departmentLabel) departmentLabel = String(employee.department_name ?? "");
    } else if (input.providerId) {
      const provider = await d1.prepare(`SELECT id FROM fdp_auxiliary_providers
        WHERE workspace_id = ? AND id = ? AND provider_type = 'contractor'`)
        .bind(workspace.id, input.providerId).first<{ id: string }>();
      if (!provider) throw ApiError.badRequest("Prestador PJ não encontrado.", "LEDGER_PROVIDER_NOT_FOUND");
      employmentTypeSnapshot = "pj";
    }

    const id = crypto.randomUUID();
    const planned = plannedRowsFor(input);
    const requestId = request.headers.get("x-fila-dp-request-id");

    await d1.batch([
      d1.prepare(`INSERT INTO fdp_ledger_entries
        (id, workspace_id, company_id, employee_id, provider_id, employment_type_snapshot,
         department_id, department_label, unit_label, operation_label,
         requester_area_id, responsible_area_id, category, title, description, reason,
         occurred_on, requested_on, requested_by, responsible_user_id,
         total_amount, modality, installment_count, first_competence, expected_end_competence,
         recurrence_end_competence, settlement_target, status, details_json, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?::jsonb, ?, ?)`)
        .bind(id, workspace.id, input.companyId, input.employeeId, input.providerId, employmentTypeSnapshot,
          departmentId, departmentLabel, input.unitLabel, input.operationLabel,
          input.requesterAreaId, input.responsibleAreaId, input.category, input.title, input.description, input.reason,
          input.occurredOn, input.requestedOn, user.id, input.responsibleUserId,
          input.totalAmount, input.modality, input.installmentCount, input.firstCompetence, input.expectedEndCompetence,
          input.recurrenceEndCompetence, input.settlementTarget, JSON.stringify(input.details), user.id, user.id),
      ...planned.map((part) => d1.prepare(`INSERT INTO fdp_ledger_installments
        (id, workspace_id, entry_id, company_id, number, total_count, competence, planned_amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(part.id, workspace.id, id, input.companyId, part.number, part.totalCount, part.competence, part.plannedAmount)),
      /* O recorrente não tem parcelas a programar de saída — ele tem um valor
         por mês. Esse valor nasce aqui, como a primeira vigência, no mesmo lote
         do lançamento: separar as duas escritas deixaria uma janela em que o
         lançamento existe sem valor, e foi assim que o vale fixo ficou órfão. */
      ...(input.recurringCents === null ? [] : [d1.prepare(`INSERT INTO fdp_ledger_advance_rules
        (id, workspace_id, entry_id, mode, fixed_amount, effective_from_competence,
         end_competence, status, note, created_by)
        VALUES (?, ?, ?, 'fixed_monthly', ?, ?, ?, 'active', ?, ?)`)
        .bind(crypto.randomUUID(), workspace.id, id,
          fromCents(input.recurringCents), input.firstCompetence,
          input.recurrenceEndCompetence, "Valor informado na criação do lançamento.", user.id)]),
      d1.prepare(`INSERT INTO fdp_ledger_events (id, workspace_id, entry_id, event_type, summary, payload_json, actor_user_id)
        VALUES (?, ?, ?, 'created', ?, ?::jsonb, ?)`)
        .bind(crypto.randomUUID(), workspace.id, id, input.title,
          JSON.stringify({ modality: input.modality, totalAmount: input.totalAmount, installments: planned.length }), user.id),
      ...(planned.length ? [d1.prepare(`INSERT INTO fdp_ledger_events (id, workspace_id, entry_id, event_type, summary, payload_json, actor_user_id)
        VALUES (?, ?, ?, 'installments_generated', ?, ?::jsonb, ?)`)
        .bind(crypto.randomUUID(), workspace.id, id, `${planned.length} parcela(s) programada(s)`,
          JSON.stringify({ first: planned[0]?.competence, last: planned.at(-1)?.competence }), user.id)] : []),
      /* O valor entra na trilha; o motivo e a descrição não. A trilha guarda o
         que mudou no dinheiro, não o relato sobre a pessoa — quem precisa do
         caso abre o lançamento, onde a permissão do módulo vale. */
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "ledger_entry.created", entityType: "ledger_entry", entityId: id,
        after: {
          companyId: input.companyId, employeeId: input.employeeId, providerId: input.providerId,
          category: input.category, modality: input.modality, totalAmount: input.totalAmount,
          installmentCount: input.installmentCount, firstCompetence: input.firstCompetence,
          settlementTarget: input.settlementTarget, status: "draft",
        },
        metadata: { installmentsGenerated: planned.length, detailKeys: Object.keys(input.details) },
        requestId,
      }),
    ]);

    return Response.json({
      entry: {
        id, ...input, status: "draft", employmentTypeSnapshot, departmentId, departmentLabel,
        installments: planned,
      },
    }, { status: 201 });
  } catch (error) { return apiError(error); }
}
