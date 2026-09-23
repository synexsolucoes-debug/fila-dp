import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText, getCatalogResource } from "@/lib/registrations";
import { readSankhyaCatalogWorkbook, type SankhyaCatalogKind } from "@/lib/sankhya-catalog-xlsx";
import { readSankhyaWorkScheduleWorkbook } from "@/lib/sankhya-work-schedule-xlsx";

type Context = { params: Promise<{ resource: string }> };
type Existing = { id: string; code: string; name: string; cbo_code: string; weekly_hours: number; description: string; status: string };
/** Formato comum entre os dois leitores — jornada não tem `cboCode`, os outros não têm `weeklyHours`/`description`. */
type ImportRecord = { code: string; name: string; status: string; cboCode?: string; weeklyHours?: number; description?: string };

const catalogKinds: Readonly<Partial<Record<string, SankhyaCatalogKind>>> = {
  positions: "positions", departments: "departments", unions: "unions",
};

async function readRecords(key: string, buffer: ArrayBuffer): Promise<ImportRecord[]> {
  if (key === "work-schedules") {
    const records = await readSankhyaWorkScheduleWorkbook(buffer);
    return records.map((r) => ({ ...r, status: "active" }));
  }
  const kind = catalogKinds[key];
  if (!kind) throw ApiError.badRequest("Este cadastro não aceita importação do Sankhya.", "CATALOG_IMPORT_UNSUPPORTED");
  return readSankhyaCatalogWorkbook(buffer, kind);
}

export async function POST(request: Request, context: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { resource: key } = await context.params;
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

    const records = await readRecords(key, await file.arrayBuffer());
    const extra = key === "positions" ? "cbo_code, 0 AS weekly_hours, '' AS description"
      : key === "work-schedules" ? "'' AS cbo_code, weekly_hours, description"
      : "'' AS cbo_code, 0 AS weekly_hours, '' AS description";
    const existing = await d1.prepare(`SELECT id, code, name, ${extra}, status
      FROM ${resource.table} WHERE workspace_id = ? AND company_id = ?`).bind(workspace.id, companyId).all<Existing>();
    const byCode = new Map(existing.results.map((row) => [String(row.code), row]));

    const items = records.map((record) => {
      const match = byCode.get(record.code) ?? null;
      if (!match) return { record, match, classification: "new" as const };
      const changed = String(match.name) !== record.name || String(match.status) !== record.status
        || (key === "positions" && String(match.cbo_code ?? "") !== record.cboCode)
        || (key === "work-schedules" && (Number(match.weekly_hours) !== record.weeklyHours || String(match.description ?? "") !== record.description));
      return { record, match, classification: changed ? "changed" as const : "unchanged" as const };
    });

    if (action === "preview") return Response.json({
      summary: Object.fromEntries(["new", "changed", "unchanged"].map((label) => [label, items.filter((item) => item.classification === label).length])),
      items: items.slice(0, 1000).map(({ record, classification }) => ({
        code: record.code, name: record.name, cboCode: record.cboCode ?? "", weeklyHours: record.weeklyHours ?? null,
        description: record.description ?? "", status: record.status, classification,
      })),
    });

    const statements: D1PreparedStatement[] = [];
    let created = 0; let updated = 0; let unchanged = 0;
    for (const item of items) {
      if (item.classification === "unchanged") { unchanged += 1; continue; }
      if (item.classification === "new") created += 1; else updated += 1;
      const id = item.match?.id ?? crypto.randomUUID();
      if (key === "positions") {
        statements.push(d1.prepare(`INSERT INTO ${resource.table} (id, workspace_id, company_id, code, name, cbo_code, status)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (workspace_id, company_id, code) DO UPDATE SET name = EXCLUDED.name, cbo_code = EXCLUDED.cbo_code,
            status = EXCLUDED.status, updated_at = CURRENT_TIMESTAMP`)
          .bind(id, workspace.id, companyId, item.record.code, item.record.name, item.record.cboCode ?? "", item.record.status));
      } else if (key === "work-schedules") {
        statements.push(d1.prepare(`INSERT INTO ${resource.table} (id, workspace_id, company_id, code, name, weekly_hours, description, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (workspace_id, company_id, code) DO UPDATE SET name = EXCLUDED.name, weekly_hours = EXCLUDED.weekly_hours,
            description = EXCLUDED.description, status = EXCLUDED.status, updated_at = CURRENT_TIMESTAMP`)
          .bind(id, workspace.id, companyId, item.record.code, item.record.name, item.record.weeklyHours ?? 44, item.record.description ?? "", item.record.status));
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
