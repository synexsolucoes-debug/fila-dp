import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { readEventCatalogWorkbook } from "@/lib/payroll-movements-xlsx";
import { loadEventCatalog } from "@/lib/payroll-movements-service";

/**
 * Catálogo de eventos da folha (TFPEVE).
 *
 * A importação lê o "Resultado da Query" exportado do Sankhya e atualiza por
 * código: evento novo entra, evento existente recebe descrição, unidade, tipo
 * e situação do arquivo. Evento que não veio no arquivo continua como estava —
 * uma query filtrada não pode apagar o resto do catálogo.
 */
export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "hr.read");
    const catalog = await loadEventCatalog(d1, workspace.id);
    return Response.json({ events: [...catalog.events.values()], updatedAt: catalog.updatedAt },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw ApiError.badRequest("Selecione a planilha da query de eventos do Sankhya.", "PAYROLL_EVENT_CATALOG_FILE");
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      throw ApiError.badRequest("Envie a planilha em .xlsx. Se o Sankhya exportou .xls, abra no Excel e use Salvar como .xlsx.", "PAYROLL_EVENT_CATALOG_TYPE");
    }
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "hr.write");

    let parsed: Awaited<ReturnType<typeof readEventCatalogWorkbook>>;
    try { parsed = await readEventCatalogWorkbook(await file.arrayBuffer()); }
    catch (cause) { throw ApiError.badRequest(cause instanceof Error ? cause.message : "Não foi possível ler a planilha.", "PAYROLL_EVENT_CATALOG_INVALID"); }

    const existing = await loadEventCatalog(d1, workspace.id);
    let created = 0;
    let updated = 0;
    const statements = parsed.events.map((event) => {
      const current = existing.events.get(event.code);
      if (!current) created += 1;
      else if (current.description !== event.description || current.unit !== event.unit
        || current.eventType !== event.eventType || current.active !== event.active) updated += 1;
      return d1.prepare(`INSERT INTO fdp_payroll_event_catalog
        (id, workspace_id, code, description, unit, event_type, status, imported_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, code) DO UPDATE SET
          description = excluded.description, unit = excluded.unit, event_type = excluded.event_type,
          status = excluded.status, imported_by = excluded.imported_by, updated_at = now()`)
        .bind(crypto.randomUUID(), workspace.id, event.code, event.description, event.unit, event.eventType,
          event.active ? "active" : "inactive", user.id);
    });
    statements.push(prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "payroll_event_catalog.imported", entityType: "payroll_event_catalog", entityId: workspace.id,
      after: { events: parsed.events.length, created, updated, skipped: parsed.skipped },
    }));
    await d1.batch(statements);

    return Response.json({ events: parsed.events.length, created, updated, skipped: parsed.skipped },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
