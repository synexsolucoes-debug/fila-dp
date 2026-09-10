import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { cleanText } from "@/lib/clean-text";
import {
  accidentBodyPartLabels, accidentGenderLabels, accidentShiftLabels, accidentTypeLabels,
} from "@/lib/work-accidents";
import { workAccidentFromRow } from "@/lib/work-accidents-service";

const MAX_ROWS = 20_000;

function csvCell(value: unknown) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  // O apóstrofo à frente neutraliza fórmula em planilha: um campo livre que
  // comece com `=` vira código executável ao abrir o arquivo.
  const guarded = /^[=+\-@\t\r]/u.test(text) ? `'${text}` : text;
  return `"${guarded.replaceAll('"', '""')}"`;
}

const COLUMNS = [
  "Empresa", "Data", "Tipo", "Parte do corpo", "Setor", "Turno", "Gênero",
  "Colaborador", "Dias afastados", "Despesa", "CAT emitida", "Nº da CAT", "Descrição",
] as const;

/**
 * Os acidentes do recorte em planilha.
 *
 * Exportar é permissão própria (`safety.export`) porque o arquivo sai da tela e
 * entra em anexo de e-mail: ele leva o nome do colaborador e a descrição do
 * acidente juntos, que é o par que o dashboard nunca mostra na mesma linha.
 * Quem exporta fica registrado na trilha, com o recorte pedido e a contagem de
 * linhas — sem isso, um vazamento não teria de onde começar a ser investigado.
 */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "safety.export", "exportar os acidentes de trabalho");
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
    const year = Number(cleanText(url.searchParams.get("year"), 4));
    if (Number.isInteger(year) && year >= 1900 && year <= 2999) {
      conditions.push("(accident.occurred_on >= ? AND accident.occurred_on < ?)");
      values.push(`${year}-01-01`, `${year + 1}-01-01`);
    }

    const result = await d1.prepare(`SELECT accident.*,
        COALESCE(NULLIF(company.trade_name, ''), company.legal_name) AS company_name
      FROM fdp_work_accidents accident
      JOIN fdp_companies company
        ON company.workspace_id = accident.workspace_id AND company.id = accident.company_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY accident.occurred_on DESC, accident.id DESC
      LIMIT ?`).bind(...values, MAX_ROWS).all<Record<string, unknown>>();

    const lines = result.results.map(workAccidentFromRow).map((record) => [
      record.companyName,
      record.occurredOn,
      accidentTypeLabels[record.accidentType] ?? record.accidentType,
      accidentBodyPartLabels[record.bodyPart] ?? record.bodyPart,
      record.sector,
      accidentShiftLabels[record.shift] ?? record.shift,
      accidentGenderLabels[record.gender] ?? record.gender,
      record.employeeLabel,
      record.leaveDays,
      record.expenseAmount.toFixed(2).replace(".", ","),
      record.catIssued ? "Sim" : "Não",
      record.catNumber,
      record.description,
    ].map(csvCell).join(";"));

    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "work_accident.exported", entityType: "work_accident_report", entityId: companyId || "all",
      metadata: { companyId: companyId || "all", year: year || "all", rows: result.results.length },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    // BOM para o Excel em português abrir o arquivo em UTF-8 sem estragar os
    // acentos — sem ele "Abdômen" chega como "AbdÃ´men".
    const header = COLUMNS.map(csvCell).join(";");
    return new Response(`﻿${[header, ...lines].join("\r\n")}\r\n`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="acidentes-trabalho-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) { return apiError(error); }
}
