import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";

/** A prévia gravada: as linhas, a interpretação e as ambiguidades de cada uma. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "ledger.import", "consultar a importação da planilha");

    const importacao = await d1.prepare(`SELECT * FROM fdp_ledger_imports
      WHERE workspace_id = ? AND id = ?`).bind(workspace.id, id).first<Record<string, unknown>>();
    if (!importacao) throw ApiError.notFound("Importação não encontrada.", "LEDGER_IMPORT_NOT_FOUND");

    const url = new URL(request.url);
    const resolution = cleanText(url.searchParams.get("resolution"), 20);
    const conditions = ["row.workspace_id = ?", "row.import_id = ?"];
    const values: unknown[] = [workspace.id, id];
    if (["pending", "resolved", "ignored"].includes(resolution)) {
      conditions.push("row.resolution = ?"); values.push(resolution);
    }

    const rows = await d1.prepare(`SELECT row.*, employee.full_name AS employee_name
      FROM fdp_ledger_import_rows row
      LEFT JOIN fdp_employees employee
        ON employee.workspace_id = row.workspace_id AND employee.id = row.employee_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY row.sheet_name, row.row_number
      LIMIT 2000`).bind(...values).all<Record<string, unknown>>();

    const totals = await d1.prepare(`SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE resolution = 'resolved')::int AS resolved,
        COUNT(*) FILTER (WHERE resolution = 'ignored')::int AS ignored,
        COUNT(*) FILTER (WHERE entry_id IS NOT NULL)::int AS committed,
        COUNT(*) FILTER (WHERE employee_id IS NULL)::int AS unidentified
      FROM fdp_ledger_import_rows WHERE workspace_id = ? AND import_id = ?`)
      .bind(workspace.id, id).first<Record<string, unknown>>();

    return Response.json({ import: importacao, rows: rows.results, totals });
  } catch (error) { return apiError(error); }
}

/**
 * Resolve uma linha da prévia — ou desiste dela.
 *
 * Resolver é dizer quem é a pessoa e o que exatamente vai virar lançamento. A
 * interpretação automática é um ponto de partida: tudo aqui é sobrescrevível, e
 * nada é gravado como lançamento neste passo.
 *
 * Uma linha só fica `resolved` quando tem pessoa **e** a proposta escolhida tem
 * o que um lançamento precisa. Enquanto faltar algo ela continua pendente, e a
 * gravação recusa o lote inteiro em vez de gravar meia importação.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "ledger.import", "revisar a importação da planilha");

    const importacao = await d1.prepare(`SELECT id, status, mapping_json FROM fdp_ledger_imports
      WHERE workspace_id = ? AND id = ?`).bind(workspace.id, id).first<Record<string, unknown>>();
    if (!importacao) throw ApiError.notFound("Importação não encontrada.", "LEDGER_IMPORT_NOT_FOUND");
    if (String(importacao.status) === "committed") {
      throw ApiError.badRequest("Esta importação já foi gravada.", "LEDGER_IMPORT_COMMITTED");
    }

    /* Cancelar a importação inteira: as linhas ficam, marcadas como ignoradas,
       porque o registro de que alguém tentou importar isto tem valor. */
    if (body.cancel === true) {
      await d1.batch([
        d1.prepare(`UPDATE fdp_ledger_imports SET status = 'canceled' WHERE workspace_id = ? AND id = ?`)
          .bind(workspace.id, id),
        d1.prepare(`UPDATE fdp_ledger_import_rows SET resolution = 'ignored'
          WHERE workspace_id = ? AND import_id = ? AND entry_id IS NULL`)
          .bind(workspace.id, id),
        prepareAuditEvent({
          workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
          action: "ledger_import.canceled", entityType: "ledger_import", entityId: id,
          before: { status: String(importacao.status) }, after: { status: "canceled" },
          requestId: request.headers.get("x-fila-dp-request-id"),
        }),
      ]);
      return Response.json({ import: { id, status: "canceled" } });
    }

    const rowId = cleanText(body.rowId, 120);
    if (!rowId) throw ApiError.badRequest("Informe a linha a resolver.", "LEDGER_IMPORT_ROW_REQUIRED");

    const row = await d1.prepare(`SELECT * FROM fdp_ledger_import_rows
      WHERE workspace_id = ? AND import_id = ? AND id = ?`)
      .bind(workspace.id, id, rowId).first<Record<string, unknown>>();
    if (!row) throw ApiError.notFound("Linha não encontrada nesta importação.", "LEDGER_IMPORT_ROW_NOT_FOUND");
    if (row.entry_id) {
      throw ApiError.badRequest("Esta linha já virou lançamento.", "LEDGER_IMPORT_ROW_COMMITTED");
    }

    const resolution = cleanText(body.resolution, 20);
    if (resolution === "ignored") {
      await d1.prepare(`UPDATE fdp_ledger_import_rows SET resolution = 'ignored'
        WHERE workspace_id = ? AND id = ?`).bind(workspace.id, rowId).run();
      return Response.json({ row: { id: rowId, resolution: "ignored" } });
    }

    const employeeId = cleanText(body.employeeId, 120);
    if (!employeeId) {
      throw ApiError.badRequest(
        "Escolha a pessoa desta linha. Nome sozinho não identifica alguém numa base com homônimos.",
        "LEDGER_IMPORT_EMPLOYEE_REQUIRED",
      );
    }

    const mapping = (importacao.mapping_json ?? {}) as { companyId?: string };
    const pessoa = await d1.prepare(`SELECT id FROM fdp_employees
      WHERE workspace_id = ? AND company_id = ? AND id = ?`)
      .bind(workspace.id, String(mapping.companyId ?? ""), employeeId).first<{ id: string }>();
    if (!pessoa) {
      throw ApiError.badRequest("A pessoa escolhida não pertence à empresa desta importação.", "LEDGER_IMPORT_EMPLOYEE_MISMATCH");
    }

    /* A decisão da pessoa sobre o que a linha significa. Ela substitui a
       interpretação automática, e o texto original continua intocado em
       `raw_json` para quem quiser conferir de onde tudo saiu. */
    const escolhido = body.candidate && typeof body.candidate === "object"
      ? body.candidate as Record<string, unknown>
      : null;
    if (!escolhido) {
      throw ApiError.badRequest("Escolha qual lançamento esta linha vai gerar.", "LEDGER_IMPORT_CANDIDATE_REQUIRED");
    }

    const parsed = (row.parsed_json ?? {}) as Record<string, unknown>;
    await d1.batch([
      d1.prepare(`UPDATE fdp_ledger_import_rows
        SET resolution = 'resolved', employee_id = ?, parsed_json = ?::jsonb, ambiguities_json = '[]'::jsonb
        WHERE workspace_id = ? AND id = ? AND entry_id IS NULL`)
        .bind(employeeId, JSON.stringify({ ...parsed, chosen: escolhido }), workspace.id, rowId),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "ledger_import.row_resolved", entityType: "ledger_import", entityId: id,
        after: { rowId, employeeId, category: String(escolhido.category ?? "") },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ row: { id: rowId, resolution: "resolved", employeeId } });
  } catch (error) { return apiError(error); }
}
