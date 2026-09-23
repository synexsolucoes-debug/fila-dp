import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText, getCatalogResource } from "@/lib/registrations";
import { readSankhyaCatalogWorkbook, type SankhyaCatalogKind } from "@/lib/sankhya-catalog-xlsx";

type Context = { params: Promise<{ resource: string }> };
type Existing = { id: string; code: string; name: string; cbo_code: string; status: string };

/**
 * Só cargo, departamento e sindicato têm exportação equivalente no Sankhya
 * ("Resultado da Query" por CODCARGO/CODDEP/CODSIND) — centro de custo e
 * jornada não têm essa origem hoje, então não entram aqui.
 */
const importableKinds: Readonly<Partial<Record<string, SankhyaCatalogKind>>> = {
  positions: "positions", departments: "departments", unions: "unions",
};

export async function POST(request: Request, context: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { resource: key } = await context.params;
    const kind = importableKinds[key];
    if (!kind) throw ApiError.badRequest("Este cadastro não aceita importação do Sankhya.", "CATALOG_IMPORT_UNSUPPORTED");
    const resource = getCatalogResource(key);
    const form = await request.formData();
    const file = form.get("file");
    const companyId = cleanText(form.get("companyId"), 120);
    const action = form.get("action") === "import" ? "import" : "preview";
    if (!(file instanceof File) || !companyId) throw ApiError.badRequest("Selecione a empresa e a planilha Sankhya.", "CATALOG_IMPORT_REQUIRED");
    if (!file.name.toLowerCase().endsWith(".xlsx")) throw ApiError.badRequest("Envie uma planilha .xlsx.", "CATALOG_IMPORT_TYPE");
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "registrations.catalogs.manage");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);

    const records = await readSankhyaCatalogWorkbook(await file.arrayBuffer(), kind);
    const existing = await d1.prepare(`SELECT id, code, name, ${kind === "positions" ? "cbo_code" : "'' AS cbo_code"}, status
      FROM ${resource.table} WHERE workspace_id = ? AND company_id = ?`).bind(workspace.id, companyId).all<Existing>();
    const byCode = new Map(existing.results.map((row) => [String(row.code), row]));

    const items = records.map((record) => {
      const match = byCode.get(record.code) ?? null;
      if (!match) return { record, match, classification: "new" as const };
      const changed = String(match.name) !== record.name || String(match.status) !== record.status
        || (kind === "positions" && String(match.cbo_code ?? "") !== record.cboCode);
      return { record, match, classification: changed ? "changed" as const : "unchanged" as const };
    });

    if (action === "preview") return Response.json({
      summary: Object.fromEntries(["new", "changed", "unchanged"].map((label) => [label, items.filter((item) => item.classification === label).length])),
      items: items.slice(0, 1000).map(({ record, classification }) => ({ code: record.code, name: record.name, cboCode: record.cboCode, status: record.status, classification })),
    });

    const statements: D1PreparedStatement[] = [];
    let created = 0; let updated = 0; let unchanged = 0;
    for (const item of items) {
      if (item.classification === "unchanged") { unchanged += 1; continue; }
      if (item.classification === "new") created += 1; else updated += 1;
      const id = item.match?.id ?? crypto.randomUUID();
      if (kind === "positions") {
        statements.push(d1.prepare(`INSERT INTO ${resource.table} (id, workspace_id, company_id, code, name, cbo_code, status)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (workspace_id, company_id, code) DO UPDATE SET name = EXCLUDED.name, cbo_code = EXCLUDED.cbo_code,
            status = EXCLUDED.status, updated_at = CURRENT_TIMESTAMP`)
          .bind(id, workspace.id, companyId, item.record.code, item.record.name, item.record.cboCode, item.record.status));
      } else {
        statements.push(d1.prepare(`INSERT INTO ${resource.table} (id, workspace_id, company_id, code, name, status)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (workspace_id, company_id, code) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, updated_at = CURRENT_TIMESTAMP`)
          .bind(id, workspace.id, companyId, item.record.code, item.record.name, item.record.status));
      }
    }
    statements.push(prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: `registration.${key}.sankhya_imported`, entityType: `registration_${key}`, entityId: crypto.randomUUID(),
      after: { companyId, fileName: file.name, total: records.length, created, updated, unchanged },
      requestId: request.headers.get("x-fila-dp-request-id") }));
    await d1.batch(statements);
    return Response.json({ created, updated, unchanged });
  } catch (error) {
    return apiError(error instanceof Error && !(error instanceof ApiError) ? ApiError.badRequest(error.message, "CATALOG_IMPORT_INVALID") : error);
  }
}
