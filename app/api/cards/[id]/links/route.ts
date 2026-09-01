import { ApiError, apiError, getApiUser } from "@/lib/fila-dp-api";
import {
  getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent,
  requireCardCompanyAccess,
} from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { cleanText } from "@/lib/registrations";

type RouteContext = { params: Promise<{ id: string }> };
type Row = Record<string, unknown>;

const targets = {
  competence: {
    href: "/painel/operacao",
    query: "SELECT id, company_id, competence AS default_label FROM fdp_payroll_cycles WHERE workspace_id = ? AND id = ?",
  },
  movement: {
    href: "/painel/operacao",
    query: "SELECT id, company_id, title AS default_label FROM fdp_employee_movements WHERE workspace_id = ? AND id = ?",
  },
  obligation: {
    href: "/painel/operacao",
    query: "SELECT id, company_id, title AS default_label FROM fdp_compliance_obligations WHERE workspace_id = ? AND id = ?",
  },
  benefit: {
    href: "/painel/auxiliares",
    query: "SELECT id, company_id, title AS default_label FROM fdp_auxiliary_executions WHERE workspace_id = ? AND id = ? AND module_type = 'benefits'",
  },
  contractor: {
    href: "/painel/pj/fechamentos",
    query: "SELECT id, company_id, competence AS default_label FROM fdp_contractor_closings WHERE workspace_id = ? AND id = ?",
  },
  epi: {
    href: "/painel/epi",
    query: "SELECT id, company_id, id AS default_label FROM fdp_epi_deliveries WHERE workspace_id = ? AND id = ?",
  },
  integration: {
    href: "/painel/integracoes",
    query: "SELECT id, NULL::text AS company_id, display_name AS default_label FROM fdp_integrations WHERE workspace_id = ? AND id = ?",
  },
} as const;

type ModuleKey = keyof typeof targets;
const isModuleKey = (value: string): value is ModuleKey => value in targets;
const text = (value: unknown) => value == null ? "" : String(value);

async function demandContext(
  authUser: NonNullable<Awaited<ReturnType<typeof getApiUser>>["user"]>,
  cardId: string,
  capability: "cards.read" | "cards.write",
) {
  const { d1, workspace, board, user } = await getWorkspaceContext(authUser);
  requireCapability(workspace, capability);
  await requireCardCompanyAccess(d1, workspace.id, user.id, workspace.role, cardId);
  const card = await d1.prepare(
    "SELECT id, company_id FROM fdp_cards WHERE workspace_id = ? AND board_id = ? AND id = ?",
  ).bind(workspace.id, board.id, cardId).first<{ id: string; company_id: string | null }>();
  if (!card) throw ApiError.notFound("Demanda não encontrada.", "CARD_NOT_FOUND");
  return { d1, workspace, user, card };
}

export async function GET(_request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace } = await demandContext(auth.user, id, "cards.read");
    const result = await d1.prepare(`SELECT id, module_key, entity_id, label, metadata_json, created_at
      FROM fdp_demand_module_links WHERE workspace_id = ? AND card_id = ?
      ORDER BY created_at, id`).bind(workspace.id, id).all<Row>();
    return Response.json({ links: result.results.map((row) => {
      const moduleKey = text(row.module_key);
      return {
        id: text(row.id), moduleKey, entityId: text(row.entity_id), label: text(row.label),
        metadata: row.metadata_json ?? {}, createdAt: text(row.created_at),
        href: isModuleKey(moduleKey) ? targets[moduleKey].href : "/painel",
      };
    }) });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Row;
    const { d1, workspace, user, card } = await demandContext(auth.user, id, "cards.write");

    const moduleKey = cleanText(body.moduleKey, 40).toLowerCase();
    const entityId = cleanText(body.entityId, 120);
    if (!isModuleKey(moduleKey) || !entityId) {
      throw ApiError.badRequest("Módulo e entidade vinculada são obrigatórios.", "DEMAND_LINK_REQUIRED");
    }
    const target = await d1.prepare(targets[moduleKey].query)
      .bind(workspace.id, entityId).first<{ id: string; company_id: string | null; default_label: string }>();
    if (!target) throw ApiError.notFound("Entidade não encontrada neste workspace.", "DEMAND_LINK_TARGET_NOT_FOUND");

    const companyAccess = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    if (target.company_id && !companyAccess.unrestricted && !companyAccess.companyIds.has(target.company_id)) {
      throw ApiError.notFound("Entidade não encontrada neste workspace.", "DEMAND_LINK_TARGET_NOT_FOUND");
    }
    if (card.company_id && target.company_id && card.company_id !== target.company_id) {
      throw ApiError.badRequest("A entidade pertence a outra empresa da demanda.", "DEMAND_LINK_COMPANY_MISMATCH");
    }

    const existing = await d1.prepare(`SELECT id FROM fdp_demand_module_links
      WHERE workspace_id = ? AND card_id = ? AND module_key = ? AND entity_id = ?`)
      .bind(workspace.id, id, moduleKey, entityId).first<{ id: string }>();
    const linkId = existing?.id ?? crypto.randomUUID();
    const label = cleanText(body.label, 180) || cleanText(target.default_label, 180) || `${moduleKey} ${entityId.slice(0, 12)}`;
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_demand_module_links
        (id, workspace_id, card_id, module_key, entity_id, label, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, card_id, module_key, entity_id)
        DO UPDATE SET label = EXCLUDED.label`).bind(linkId, workspace.id, id, moduleKey, entityId, label, user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "demand.module_linked", entityType: "demand", entityId: id,
        after: { moduleKey, linkedEntityId: entityId, label },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ link: { id: linkId, moduleKey, entityId, label, href: targets[moduleKey].href } }, { status: 201 });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request, context: RouteContext) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Row;
    const { d1, workspace, user } = await demandContext(auth.user, id, "cards.write");
    const linkId = cleanText(body.linkId, 120);
    const link = await d1.prepare(`SELECT id, module_key, entity_id, label
      FROM fdp_demand_module_links WHERE workspace_id = ? AND card_id = ? AND id = ?`)
      .bind(workspace.id, id, linkId).first<Row>();
    if (!link) throw ApiError.notFound("Vínculo não encontrado nesta demanda.", "DEMAND_LINK_NOT_FOUND");
    await d1.batch([
      d1.prepare("DELETE FROM fdp_demand_module_links WHERE workspace_id = ? AND card_id = ? AND id = ?")
        .bind(workspace.id, id, linkId),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "demand.module_unlinked", entityType: "demand", entityId: id,
        before: { moduleKey: text(link.module_key), linkedEntityId: text(link.entity_id), label: text(link.label) },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ ok: true });
  } catch (error) { return apiError(error); }
}
