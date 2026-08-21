import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { centsFromDatabase } from "@/lib/payments";
import { assertExportable, buildCajuPreview, cajuFileName, describeCajuBlock, type CajuCandidate } from "@/lib/caju-export";
import { buildCajuFile, type CajuTemplateShape } from "@/lib/caju-template";

/**
 * Conferência e geração do arquivo de pedidos da Caju para uma competência.
 *
 * `GET` devolve a prévia — quem entra, quem está bloqueado e por quê, e o total.
 * `POST` gera o arquivo, e só gera se a prévia estiver limpa. A regra que não
 * pode ser afrouxada: exportação silenciosamente incompleta é pior que
 * exportação recusada. O total conferido na tela precisa ser exatamente o total
 * do arquivo.
 */

type CandidateRow = {
  closing_id: string;
  company_id: string;
  competence: string;
  status: string;
  caju_amount: string;
  complement_method: string;
  provider_id: string;
  legal_name: string;
  trade_name: string;
  tax_id: string;
};

type TemplateRow = {
  id: string;
  version: number;
  delimiter: string;
  format: string;
  category_key: string;
  amount_label: string;
  column_map_json: string;
};

/** Reconstrói o formato a partir do que foi gravado no cadastro do modelo. */
function shapeFromRow(row: TemplateRow): CajuTemplateShape {
  const parsed = JSON.parse(row.column_map_json) as {
    headers?: unknown; taxIdIndex?: unknown; amountIndex?: unknown; emptyIndexes?: unknown;
  };
  const headers = Array.isArray(parsed.headers) ? parsed.headers.map(String) : [];
  const taxIdIndex = Number(parsed.taxIdIndex);
  const amountIndex = Number(parsed.amountIndex);
  if (headers.length === 0 || !Number.isInteger(taxIdIndex) || !Number.isInteger(amountIndex)
    || taxIdIndex < 0 || amountIndex < 0 || taxIdIndex >= headers.length || amountIndex >= headers.length) {
    // Cadastro corrompido não vira arquivo torto: recusa e pede novo upload.
    throw new ApiError(409, "CAJU_TEMPLATE_MISSING",
      "O modelo cadastrado está ilegível. Cadastre novamente a planilha de pedidos baixada do portal da Caju.");
  }
  return {
    headers,
    delimiter: row.delimiter,
    taxIdIndex,
    amountIndex,
    amountLabel: row.amount_label,
    emptyIndexes: Array.isArray(parsed.emptyIndexes) ? parsed.emptyIndexes.map(Number) : [],
  };
}

async function loadContext(user: NonNullable<Awaited<ReturnType<typeof getApiUser>>["user"]>, url: URL) {
  const cycleId = url.searchParams.get("competenceId") ?? "";
  if (!cycleId) throw ApiError.badRequest("Informe a competência a exportar.", "CAJU_COMPETENCE_REQUIRED");

  const { d1, workspace, user: actor } = await getWorkspaceContext(user);
  requireCapability(workspace, "contractors.export_caju");

  const cycle = await d1.prepare("SELECT id, company_id, competence FROM fdp_payroll_cycles WHERE workspace_id = ? AND id = ?")
    .bind(workspace.id, cycleId).first<{ id: string; company_id: string; competence: string }>();
  if (!cycle) throw ApiError.notFound("Competência não encontrada.", "PAYROLL_CYCLE_NOT_FOUND");
  await requireCompanyAccess(d1, workspace.id, actor.id, workspace.role, cycle.company_id);

  const company = await d1.prepare("SELECT trade_name, legal_name FROM fdp_companies WHERE workspace_id = ? AND id = ?")
    .bind(workspace.id, cycle.company_id).first<{ trade_name: string; legal_name: string }>();

  const rows = await d1.prepare(`SELECT c.id AS closing_id, c.company_id, c.competence, c.status, c.caju_amount, c.complement_method,
      p.id AS provider_id, p.legal_name, p.trade_name, p.tax_id
    FROM fdp_contractor_closings c
    JOIN fdp_auxiliary_providers p ON p.workspace_id = c.workspace_id AND p.id = c.provider_id
    WHERE c.workspace_id = ? AND c.payroll_cycle_id = ? AND c.excluded_at IS NULL
    ORDER BY p.legal_name`).bind(workspace.id, cycleId).all<CandidateRow>();

  const candidates: CajuCandidate[] = rows.results.map((row) => ({
    closingId: row.closing_id,
    contractorId: row.provider_id,
    contractorName: row.trade_name || row.legal_name,
    taxId: row.tax_id,
    companyId: row.company_id,
    competenceId: cycleId,
    closingStatus: row.status,
    cajuAmountCents: centsFromDatabase(row.caju_amount, "Valor destinado à Caju"),
    complementMethod: row.complement_method,
  }));

  const template = await d1.prepare(`SELECT id, version, delimiter, format, category_key, amount_label, column_map_json
    FROM fdp_caju_templates WHERE workspace_id = ? AND status = 'active'`).bind(workspace.id).first<TemplateRow>();

  return { d1, workspace, actor, cycle, company, candidates, template };
}

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { cycle, candidates, template } = await loadContext(auth.user, new URL(request.url));
    const preview = buildCajuPreview(candidates, template ? template.version : null);

    return Response.json({
      competence: { id: cycle.id, label: cycle.competence },
      template: template
        ? { version: template.version, categoryKey: template.category_key, amountLabel: template.amount_label, format: template.format }
        : null,
      eligible: preview.eligible.map((item) => ({
        contractorId: item.contractorId, contractorName: item.contractorName, amountCents: item.cajuAmountCents,
      })),
      blocked: preview.blocked.map((item) => {
        const diagnostic = describeCajuBlock(item.reason, item.closingStatus);
        return {
          closingId: item.closingId, contractorId: item.contractorId, contractorName: item.contractorName,
          closingStatus: item.closingStatus, reason: item.reason, reasonLabel: diagnostic.title, ...diagnostic,
        };
      }),
      skippedZero: preview.skippedZero,
      totalCents: preview.totalCents,
      canExport: preview.canExport,
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { workspace, actor, cycle, company, candidates, template } =
      await loadContext(auth.user, new URL(request.url));

    const preview = buildCajuPreview(candidates, template ? template.version : null);
    // Recusa antes de escrever uma linha: com bloqueio pendente não existe
    // "arquivo parcial", existe pedido errado.
    assertExportable(preview, template ? template.version : null);
    if (!template) throw new ApiError(409, "CAJU_TEMPLATE_MISSING", "Nenhum modelo oficial da Caju está configurado.");

    const shape = shapeFromRow(template);
    const content = buildCajuFile(shape, preview.eligible.map((item) => ({
      taxId: item.taxId, amountCents: item.cajuAmountCents,
    })));

    const fileName = cajuFileName(
      company?.trade_name || company?.legal_name || "empresa",
      cycle.competence,
      template.format,
    );

    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: actor.id, actorEmail: auth.user.email,
      action: "caju_export.generated", entityType: "payroll_cycle", entityId: cycle.id,
      before: null,
      // O conteúdo não vai para a trilha: são CPFs. O que fica é o que permite
      // conferir depois — quantas linhas, qual total, com qual versão do modelo.
      after: { rows: preview.eligible.length, totalCents: preview.totalCents, templateVersion: template.version },
      metadata: { competence: cycle.competence, categoryKey: template.category_key, fileName },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": template.format === "tsv" ? "text/tab-separated-values; charset=utf-8" : "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
        "X-Caju-Rows": String(preview.eligible.length),
        "X-Caju-Total-Cents": String(preview.totalCents),
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
