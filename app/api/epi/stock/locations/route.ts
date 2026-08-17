import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";

const codeOf = (value: unknown) => cleanText(value, 40).toUpperCase().replace(/[^A-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");

export async function GET() {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.view", "consultar locais de estoque");
    const result = await d1.prepare(`SELECT l.*,
      COALESCE(SUM(b.quantity), 0) AS total_quantity,
      COUNT(b.product_id) FILTER (WHERE b.quantity > 0) AS products_with_stock
      FROM fdp_stock_locations l LEFT JOIN fdp_stock_balances b
        ON b.workspace_id = l.workspace_id AND b.stock_location_id = l.id
      WHERE l.workspace_id = ? GROUP BY l.id ORDER BY l.is_default DESC, l.name`)
      .bind(workspace.id).all<Record<string, unknown>>();
    return Response.json({ locations: result.results });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.stock.adjust", "criar locais de estoque");
    const location = {
      id: crypto.randomUUID(), code: codeOf(body.code), name: cleanText(body.name, 120),
      description: cleanText(body.description, 500), isDefault: Boolean(body.isDefault),
    };
    if (!location.code || !location.name) throw ApiError.badRequest("Informe nome e código do local.", "EPI_STOCK_LOCATION_REQUIRED");
    const count = await d1.prepare("SELECT COUNT(*) AS count FROM fdp_stock_locations WHERE workspace_id = ?")
      .bind(workspace.id).first<{ count: number }>();
    if (Number(count?.count ?? 0) === 0) location.isDefault = true;
    await d1.batch([
      ...(location.isDefault ? [d1.prepare("UPDATE fdp_stock_locations SET is_default = 0, updated_by = ?, updated_at = now() WHERE workspace_id = ? AND is_default = 1")
        .bind(user.id, workspace.id)] : []),
      d1.prepare(`INSERT INTO fdp_stock_locations
        (id, workspace_id, code, name, description, is_default, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(location.id, workspace.id, location.code, location.name, location.description, location.isDefault ? 1 : 0, user.id, user.id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "epi_stock_location.created", entityType: "epi_stock_location", entityId: location.id, after: location,
        requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ location }, { status: 201 });
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.stock.adjust", "editar locais de estoque");
    const id = cleanText(body.id, 120);
    const before = await d1.prepare("SELECT * FROM fdp_stock_locations WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (!before) throw ApiError.notFound("Local de estoque não encontrado.", "EPI_STOCK_LOCATION_NOT_FOUND");
    const next = {
      code: body.code === undefined ? String(before.code) : codeOf(body.code),
      name: body.name === undefined ? String(before.name) : cleanText(body.name, 120),
      description: body.description === undefined ? String(before.description) : cleanText(body.description, 500),
      status: body.status === undefined ? String(before.status) : cleanText(body.status, 20),
      isDefault: body.isDefault === undefined ? Number(before.is_default) === 1 : Boolean(body.isDefault),
    };
    if (!next.code || !next.name || !["active", "inactive"].includes(next.status)) throw ApiError.badRequest("Dados do local inválidos.", "EPI_STOCK_LOCATION_INVALID");
    if (Number(before.is_default) === 1 && !next.isDefault) {
      throw ApiError.badRequest("Defina outro local como padrão; o workspace precisa manter um local padrão ativo.", "EPI_DEFAULT_LOCATION_REQUIRED");
    }
    if (next.status === "inactive" && next.isDefault) throw ApiError.badRequest("Defina outro local padrão antes de inativar este.", "EPI_DEFAULT_LOCATION_REQUIRED");
    await d1.batch([
      ...(next.isDefault ? [d1.prepare("UPDATE fdp_stock_locations SET is_default = 0, updated_by = ?, updated_at = now() WHERE workspace_id = ? AND id <> ?")
        .bind(user.id, workspace.id, id)] : []),
      d1.prepare(`UPDATE fdp_stock_locations SET code = ?, name = ?, description = ?, status = ?, is_default = ?,
        updated_by = ?, updated_at = now() WHERE workspace_id = ? AND id = ?`)
        .bind(next.code, next.name, next.description, next.status, next.isDefault ? 1 : 0, user.id, workspace.id, id),
      prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "epi_stock_location.updated", entityType: "epi_stock_location", entityId: id, before, after: next,
        requestId: request.headers.get("x-fila-dp-request-id") }),
    ]);
    return Response.json({ location: { id, ...next } });
  } catch (error) { return apiError(error); }
}
