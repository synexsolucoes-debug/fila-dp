import { getD1, getPlatformScopedD1 } from "@/db";
import { ApiError } from "@/lib/api-errors";
import { apiError, getApiUser, validDate, validProcessType } from "@/lib/fila-dp-api";
import { requiredPlatformReason, sanitizePlatformValue } from "@/lib/platform-console";
import { requirePlatformAdmin } from "@/lib/platform-authorization";
import { withPlatformContext } from "@/lib/platform-context";
import { cleanText } from "@/lib/registrations";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };
type Row = Record<string, unknown>;
const colors = new Set(["#dc2626", "#ea580c", "#d97706", "#16a34a", "#0891b2", "#2563eb", "#7c3aed", "#64748b"]);
const roles = new Set(["admin", "member", "observer", "guest"]);
const text = (value: unknown, max = 500) => cleanText(value, max);
const truthy = (value: unknown) => value === true || value === 1 || value === "1" || value === "t" || value === "true";
const safeJson = (value: unknown, fallback: unknown) => { try { return typeof value === "string" ? JSON.parse(value) : value ?? fallback; } catch { return fallback; } };
const safeWebhookUrl = (value: unknown) => { try { const url = new URL(text(value, 2000)); return `${url.origin}${url.pathname}`; } catch { return "destino inválido"; } };

async function configuration(workspaceId: string, platformUserId: string) {
  const scoped = getPlatformScopedD1({ workspaceId, userId: platformUserId });
  const [workspace, boards, lists, companies, members, labels, fields, templates, settings, holidays, sla, rules, modules, memberModuleGrants, apiKeys, webhooks] = await Promise.all([
    scoped.prepare(`SELECT id, name, slug, legal_name, tax_id, contact_email, timezone, status FROM fdp_workspaces WHERE id = ?`).bind(workspaceId).first<Row>(),
    scoped.prepare("SELECT id, name, description, board_type, created_at FROM fdp_boards WHERE workspace_id = ? ORDER BY created_at, id").bind(workspaceId).all<Row>(),
    scoped.prepare("SELECT id, board_id, name, kind, position, sla_behavior, (SELECT count(*)::int FROM fdp_cards c WHERE c.workspace_id = ? AND c.list_id = fdp_lists.id) AS card_count FROM fdp_lists WHERE workspace_id = ? ORDER BY board_id, position").bind(workspaceId, workspaceId).all<Row>(),
    scoped.prepare("SELECT id, parent_company_id, is_principal, legal_name, trade_name, tax_id, email, phone, status FROM fdp_companies WHERE workspace_id = ? ORDER BY is_principal DESC, legal_name").bind(workspaceId).all<Row>(),
    scoped.prepare(`SELECT member.user_id, users.name, users.email, member.role,
        COALESCE(json_agg(access.company_id) FILTER (WHERE access.company_id IS NOT NULL), '[]'::json) AS company_ids
      FROM fdp_workspace_members member JOIN fdp_users users ON users.id = member.user_id
      LEFT JOIN fdp_member_company_access access ON access.workspace_id = member.workspace_id AND access.user_id = member.user_id
      WHERE member.workspace_id = ? GROUP BY member.user_id, users.name, users.email, member.role ORDER BY users.name`).bind(workspaceId).all<Row>(),
    scoped.prepare("SELECT id, name, color, position FROM fdp_labels WHERE workspace_id = ? ORDER BY position").bind(workspaceId).all<Row>(),
    scoped.prepare("SELECT id, name, field_key, field_type, options_json, required, position FROM fdp_custom_fields WHERE workspace_id = ? ORDER BY position").bind(workspaceId).all<Row>(),
    scoped.prepare("SELECT id, name, process_type, description, checklist_json, default_sla_days, active, position FROM fdp_process_templates WHERE workspace_id = ? ORDER BY position").bind(workspaceId).all<Row>(),
    scoped.prepare("SELECT business_days_json, day_start, day_end, realtime_seconds, updated_at FROM fdp_workspace_settings WHERE workspace_id = ?").bind(workspaceId).first<Row>(),
    scoped.prepare("SELECT holiday_date, name FROM fdp_business_holidays WHERE workspace_id = ? ORDER BY holiday_date").bind(workspaceId).all<Row>(),
    scoped.prepare("SELECT id, process_type, target_business_days, warning_business_days, active FROM fdp_sla_policies WHERE workspace_id = ? ORDER BY process_type").bind(workspaceId).all<Row>(),
    scoped.prepare("SELECT id, name, trigger, condition_json, action_json, enabled, position FROM fdp_automation_rules WHERE workspace_id = ? ORDER BY position").bind(workspaceId).all<Row>(),
    scoped.prepare(`SELECT module.key, module.name, module.description, module.category, module.status,
        (plan_module.module_key IS NOT NULL) AS in_plan, grant.granted, grant.reason, grant.expires_at
      FROM fdp_modules module
      LEFT JOIN fdp_plan_modules plan_module ON plan_module.module_key = module.key
        AND plan_module.plan_id = (SELECT plan_id FROM fdp_workspace_subscriptions WHERE workspace_id = ?)
      LEFT JOIN fdp_workspace_module_grants grant ON grant.workspace_id = ? AND grant.module_key = module.key
      ORDER BY module.position`).bind(workspaceId, workspaceId).all<Row>(),
    scoped.prepare("SELECT user_id, module_key, granted, reason, updated_at FROM fdp_member_module_grants WHERE workspace_id = ? ORDER BY user_id, module_key").bind(workspaceId).all<Row>(),
    scoped.prepare("SELECT id, name, prefix, scopes_json, rate_limit_per_minute, status, last_used_at, expires_at, created_at FROM fdp_api_keys WHERE workspace_id = ? ORDER BY created_at DESC").bind(workspaceId).all<Row>(),
    scoped.prepare(`SELECT endpoint.id, endpoint.name, endpoint.url, endpoint.event_types_json, endpoint.status, endpoint.failure_count,
        endpoint.last_delivery_at, endpoint.last_failure_at, endpoint.created_at,
        (SELECT count(*)::int FROM fdp_webhook_deliveries delivery WHERE delivery.workspace_id = ? AND delivery.endpoint_id = endpoint.id AND delivery.status IN ('failed', 'dead_letter')) AS failed_deliveries
      FROM fdp_webhook_endpoints endpoint WHERE endpoint.workspace_id = ? ORDER BY endpoint.created_at DESC`).bind(workspaceId, workspaceId).all<Row>(),
  ]);
  if (!workspace) throw ApiError.notFound("Workspace não encontrado.", "WORKSPACE_NOT_FOUND");
  return sanitizePlatformValue({
    workspace,
    boards: boards.results,
    lists: lists.results,
    companies: companies.results.map((row) => ({ ...row, is_principal: truthy(row.is_principal) })),
    members: members.results.map((row) => ({ ...row, company_ids: safeJson(row.company_ids, []) })),
    labels: labels.results,
    fields: fields.results.map((row) => ({ ...row, required: truthy(row.required), options: safeJson(row.options_json, []), options_json: undefined })),
    templates: templates.results.map((row) => ({ ...row, active: truthy(row.active), checklist: safeJson(row.checklist_json, []), checklist_json: undefined })),
    settings: { ...settings, business_days: safeJson(settings?.business_days_json, [1, 2, 3, 4, 5]), business_days_json: undefined },
    holidays: holidays.results,
    sla: sla.results.map((row) => ({ ...row, active: truthy(row.active) })),
    rules: rules.results.map((row) => ({ ...row, enabled: truthy(row.enabled), condition: safeJson(row.condition_json, {}), action: safeJson(row.action_json, {}), condition_json: undefined, action_json: undefined })),
    modules: modules.results.map((row) => ({ ...row, in_plan: truthy(row.in_plan), granted: row.granted == null ? null : truthy(row.granted) })),
    memberModuleGrants: memberModuleGrants.results.map((row) => ({ ...row, granted: truthy(row.granted) })),
    apiKeys: apiKeys.results,
    webhooks: webhooks.results.map((row) => ({ ...row, url: safeWebhookUrl(row.url) })),
  });
}

function audit(scoped: ReturnType<typeof getPlatformScopedD1>, platform: { userId: string; email: string }, request: Request, workspaceId: string, action: string, entityType: string, entityId: string, before: Row, after: Row, reason: string) {
  const safeBefore = sanitizePlatformValue(before) as Row; const safeAfter = sanitizePlatformValue({ ...after, reason }) as Row; const requestId = request.headers.get("x-fila-dp-request-id") ?? "";
  return [
    scoped.prepare(`INSERT INTO fdp_audit_events
      (id, workspace_id, actor_type, actor_user_id, actor_email, action, outcome, entity_type, entity_id, before_json, after_json, metadata_json, request_id)
      VALUES (?, ?, 'user', ?, ?, ?, 'success', ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?)`)
      .bind(crypto.randomUUID(), workspaceId, platform.userId, platform.email, action, entityType, entityId, JSON.stringify(safeBefore), JSON.stringify(safeAfter), JSON.stringify({ source: "platform_console" }), requestId),
    scoped.prepare(`INSERT INTO fdp_platform_audit_events
      (id, actor_user_id, actor_email, action, entity_type, entity_id, before_json, after_json, request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?)`)
      .bind(crypto.randomUUID(), platform.userId, platform.email, action, entityType, entityId, JSON.stringify(safeBefore), JSON.stringify(safeAfter), requestId),
  ];
}

export async function GET(_request: Request, { params }: Params) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try { const platform = requirePlatformAdmin(auth.user); const { id } = await params; return await withPlatformContext(platform, async () => Response.json(await configuration(id, platform.userId), { headers: { "Cache-Control": "no-store" } })); }
  catch (error) { return apiError(error); }
}

export async function POST(request: Request, { params }: Params) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const platform = requirePlatformAdmin(auth.user); const { id: workspaceId } = await params; const body = await request.json() as Row;
    if (body.confirmed !== true) throw ApiError.badRequest("Confirme explicitamente a alteração administrativa.", "PLATFORM_CONFIRMATION_REQUIRED");
    const reason = requiredPlatformReason(body.reason); const action = text(body.action, 60); const payload = body.payload && typeof body.payload === "object" ? body.payload as Row : {};
    return await withPlatformContext(platform, async () => {
      const global = getD1();
      if (!await global.prepare("SELECT id FROM fdp_workspaces WHERE id = ?").bind(workspaceId).first()) throw ApiError.notFound("Workspace não encontrado.", "WORKSPACE_NOT_FOUND");
      const scoped = getPlatformScopedD1({ workspaceId, userId: platform.userId }); let entityType = "workspace_configuration"; let entityId = workspaceId; let before: Row = {}; let after: Row = {}; const statements: D1PreparedStatement[] = [];

      if (action === "workspace.update") {
        before = await scoped.prepare("SELECT name, legal_name, tax_id, contact_email, timezone FROM fdp_workspaces WHERE id = ?").bind(workspaceId).first<Row>() ?? {};
        after = { name: text(payload.name, 120) || text(before.name), legalName: text(payload.legalName, 200), taxId: text(payload.taxId, 30), contactEmail: text(payload.contactEmail, 180), timezone: text(payload.timezone, 80) || "America/Sao_Paulo" };
        if (text(after.name).length < 2) throw ApiError.badRequest("Informe o nome do workspace.", "WORKSPACE_NAME_REQUIRED");
        statements.push(scoped.prepare("UPDATE fdp_workspaces SET name = ?, legal_name = ?, tax_id = ?, contact_email = ?, timezone = ? WHERE id = ?").bind(after.name, after.legalName, after.taxId, after.contactEmail, after.timezone, workspaceId));
      } else if (action === "company.save") {
        entityType = "company"; entityId = text(payload.id, 120) || crypto.randomUUID();
        before = entityId ? await scoped.prepare("SELECT id, legal_name, trade_name, tax_id, status, is_principal, parent_company_id FROM fdp_companies WHERE workspace_id = ? AND id = ?").bind(workspaceId, entityId).first<Row>() ?? {} : {};
        const legalName = text(payload.legalName, 160); if (!legalName) throw ApiError.badRequest("Informe a razão social.", "COMPANY_LEGAL_NAME_REQUIRED");
        after = { id: entityId, legalName, tradeName: text(payload.tradeName, 160), taxId: text(payload.taxId, 30), email: text(payload.email, 160), phone: text(payload.phone, 40), status: payload.status === "inactive" ? "inactive" : "active", isPrincipal: payload.isPrincipal === true, parentCompanyId: text(payload.parentCompanyId, 120) || null };
        if (!before.id) {
          const allowance = await scoped.prepare(`SELECT plan.company_limit AS limit, (SELECT count(*)::int FROM fdp_companies WHERE workspace_id = ? AND status = 'active') AS used FROM fdp_workspace_subscriptions subscription JOIN fdp_saas_plans plan ON plan.id = subscription.plan_id WHERE subscription.workspace_id = ? AND subscription.status IN ('trialing','active')`).bind(workspaceId, workspaceId).first<{ limit: number; used: number }>();
          if (!allowance || Number(allowance.used) >= Number(allowance.limit)) throw new ApiError(409, "PLAN_COMPANY_LIMIT", "O plano atual atingiu o limite de empresas ativas.");
          statements.push(scoped.prepare(`INSERT INTO fdp_companies (id, workspace_id, parent_company_id, is_principal, legal_name, trade_name, tax_id, email, phone, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(entityId, workspaceId, after.isPrincipal ? null : after.parentCompanyId, after.isPrincipal ? 1 : 0, after.legalName, after.tradeName, after.taxId, after.email, after.phone, after.status));
        } else statements.push(scoped.prepare(`UPDATE fdp_companies SET parent_company_id = ?, is_principal = ?, legal_name = ?, trade_name = ?, tax_id = ?, email = ?, phone = ?, status = ?, updated_at = now() WHERE workspace_id = ? AND id = ?`)
          .bind(after.isPrincipal ? null : after.parentCompanyId, after.isPrincipal ? 1 : 0, after.legalName, after.tradeName, after.taxId, after.email, after.phone, after.status, workspaceId, entityId));
        if (after.isPrincipal) statements.push(scoped.prepare("UPDATE fdp_companies SET is_principal = 0, parent_company_id = ? WHERE workspace_id = ? AND id <> ? AND is_principal = 1").bind(entityId, workspaceId, entityId));
      } else if (action === "company.inactivate") {
        entityType = "company"; entityId = text(payload.id, 120); before = await scoped.prepare("SELECT id, legal_name, status FROM fdp_companies WHERE workspace_id = ? AND id = ?").bind(workspaceId, entityId).first<Row>() ?? {};
        if (!before.id) throw ApiError.notFound("Empresa não encontrada.", "COMPANY_NOT_FOUND"); after = { ...before, status: "inactive" }; statements.push(scoped.prepare("UPDATE fdp_companies SET status = 'inactive', updated_at = now() WHERE workspace_id = ? AND id = ?").bind(workspaceId, entityId));
      } else if (action === "board.save") {
        entityType = "board"; entityId = text(payload.id, 120) || crypto.randomUUID(); before = await scoped.prepare("SELECT id, name, description, board_type FROM fdp_boards WHERE workspace_id = ? AND id = ?").bind(workspaceId, entityId).first<Row>() ?? {};
        after = { id: entityId, name: text(payload.name, 80), description: text(payload.description, 300), boardType: text(payload.boardType, 30) || "general" }; if (!after.name) throw ApiError.badRequest("Informe o nome do quadro.", "BOARD_NAME_REQUIRED");
        if (before.id) statements.push(scoped.prepare("UPDATE fdp_boards SET name = ?, description = ?, board_type = ? WHERE workspace_id = ? AND id = ?").bind(after.name, after.description, after.boardType, workspaceId, entityId));
        else statements.push(scoped.prepare("INSERT INTO fdp_boards (id, workspace_id, name, description, board_type) VALUES (?, ?, ?, ?, ?)").bind(entityId, workspaceId, after.name, after.description, after.boardType), ...[["Novas demandas", "new", "running"], ["Em análise", "analysis", "running"], ["Concluído", "done", "completed"]].map(([name, kind, behavior], index) => scoped.prepare("INSERT INTO fdp_lists (id, workspace_id, board_id, name, kind, position, sla_behavior) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), workspaceId, entityId, name, kind, (index + 1) * 1000, behavior)));
      } else if (action === "board.delete") {
        entityType = "board"; entityId = text(payload.id, 120); before = await scoped.prepare("SELECT id, name FROM fdp_boards WHERE workspace_id = ? AND id = ?").bind(workspaceId, entityId).first<Row>() ?? {}; if (!before.id) throw ApiError.notFound("Quadro não encontrado.", "BOARD_NOT_FOUND");
        const count = await scoped.prepare("SELECT count(*)::int AS total FROM fdp_boards WHERE workspace_id = ?").bind(workspaceId).first<{ total: number }>(); const cards = await scoped.prepare("SELECT count(*)::int AS total FROM fdp_cards WHERE workspace_id = ? AND board_id = ?").bind(workspaceId, entityId).first<{ total: number }>();
        if (Number(count?.total ?? 0) <= 1) throw ApiError.badRequest("O workspace precisa manter ao menos um quadro.", "LAST_BOARD"); if (Number(cards?.total ?? 0) > 0) throw new ApiError(409, "BOARD_HAS_CARDS", "Mova ou arquive as demandas antes de excluir o quadro."); after = { deleted: true, reason }; statements.push(scoped.prepare("DELETE FROM fdp_boards WHERE workspace_id = ? AND id = ?").bind(workspaceId, entityId));
      } else if (action === "list.save") {
        entityType = "list"; entityId = text(payload.id, 120) || crypto.randomUUID(); before = await scoped.prepare("SELECT id, board_id, name, position, sla_behavior FROM fdp_lists WHERE workspace_id = ? AND id = ?").bind(workspaceId, entityId).first<Row>() ?? {};
        const boardId = text(payload.boardId ?? before.board_id, 120); const name = text(payload.name, 80); const behavior = ["running", "paused", "completed"].includes(text(payload.slaBehavior, 20)) ? text(payload.slaBehavior, 20) : "running"; if (!boardId || !name) throw ApiError.badRequest("Informe quadro e nome da coluna.", "LIST_INPUT_REQUIRED"); if (!await scoped.prepare("SELECT id FROM fdp_boards WHERE workspace_id = ? AND id = ?").bind(workspaceId, boardId).first()) throw ApiError.notFound("Quadro não encontrado.", "BOARD_NOT_FOUND");
        const position = before.id ? Number(before.position) : Number((await scoped.prepare("SELECT coalesce(max(position),0)::int AS value FROM fdp_lists WHERE workspace_id = ? AND board_id = ?").bind(workspaceId, boardId).first<{ value: number }>())?.value ?? 0) + 1000; after = { id: entityId, boardId, name, slaBehavior: behavior, position };
        if (before.id) statements.push(scoped.prepare("UPDATE fdp_lists SET name = ?, sla_behavior = ? WHERE workspace_id = ? AND id = ?").bind(name, behavior, workspaceId, entityId)); else statements.push(scoped.prepare("INSERT INTO fdp_lists (id, workspace_id, board_id, name, kind, position, sla_behavior) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(entityId, workspaceId, boardId, name, `custom-${crypto.randomUUID().slice(0, 10)}`, position, behavior));
      } else if (action === "list.delete") {
        entityType = "list"; entityId = text(payload.id, 120); before = await scoped.prepare("SELECT id, board_id, name FROM fdp_lists WHERE workspace_id = ? AND id = ?").bind(workspaceId, entityId).first<Row>() ?? {}; if (!before.id) throw ApiError.notFound("Coluna não encontrada.", "LIST_NOT_FOUND"); const count = await scoped.prepare("SELECT count(*)::int AS total FROM fdp_lists WHERE workspace_id = ? AND board_id = ?").bind(workspaceId, before.board_id).first<{ total: number }>(); const cards = await scoped.prepare("SELECT count(*)::int AS total FROM fdp_cards WHERE workspace_id = ? AND list_id = ?").bind(workspaceId, entityId).first<{ total: number }>(); if (Number(count?.total ?? 0) <= 1) throw ApiError.badRequest("O quadro precisa manter ao menos uma coluna.", "LAST_LIST"); if (Number(cards?.total ?? 0) > 0) throw new ApiError(409, "LIST_HAS_CARDS", "Mova as demandas antes de excluir a coluna."); after = { deleted: true, reason }; statements.push(scoped.prepare("DELETE FROM fdp_lists WHERE workspace_id = ? AND id = ?").bind(workspaceId, entityId));
      } else if (action === "label.save" || action === "label.delete") {
        entityType = "label"; entityId = text(payload.id, 120) || crypto.randomUUID(); before = await scoped.prepare("SELECT id, name, color FROM fdp_labels WHERE workspace_id = ? AND id = ?").bind(workspaceId, entityId).first<Row>() ?? {};
        if (action.endsWith("delete")) { after = { deleted: true }; statements.push(scoped.prepare("DELETE FROM fdp_labels WHERE workspace_id = ? AND id = ?").bind(workspaceId, entityId)); } else { const name = text(payload.name, 40); const color = colors.has(text(payload.color, 20)) ? text(payload.color, 20) : "#64748b"; if (!name) throw ApiError.badRequest("Informe o nome da etiqueta.", "LABEL_NAME_REQUIRED"); after = { id: entityId, name, color }; if (before.id) statements.push(scoped.prepare("UPDATE fdp_labels SET name = ?, color = ? WHERE workspace_id = ? AND id = ?").bind(name, color, workspaceId, entityId)); else statements.push(scoped.prepare("INSERT INTO fdp_labels (id, workspace_id, name, color, position) VALUES (?, ?, ?, ?, (SELECT coalesce(max(position),0)+1000 FROM fdp_labels WHERE workspace_id = ?))").bind(entityId, workspaceId, name, color, workspaceId)); }
      } else if (action === "field.save" || action === "field.delete") {
        entityType = "custom_field"; entityId = text(payload.id, 120) || crypto.randomUUID(); before = await scoped.prepare("SELECT id, name, field_key, field_type, required FROM fdp_custom_fields WHERE workspace_id = ? AND id = ?").bind(workspaceId, entityId).first<Row>() ?? {};
        if (action.endsWith("delete")) { after = { deleted: true }; statements.push(scoped.prepare("DELETE FROM fdp_custom_fields WHERE workspace_id = ? AND id = ?").bind(workspaceId, entityId)); } else { const name = text(payload.name, 60); const key = text(payload.fieldKey, 60).toLowerCase().replace(/[^a-z0-9_]/gu, "_"); const fieldType = ["text", "number", "date", "select"].includes(text(payload.fieldType, 20)) ? text(payload.fieldType, 20) : "text"; const options = Array.isArray(payload.options) ? payload.options.map((item) => text(item, 60)).filter(Boolean).slice(0, 20) : []; if (!name || !key) throw ApiError.badRequest("Informe nome e chave do campo.", "FIELD_INPUT_REQUIRED"); after = { id: entityId, name, fieldKey: key, fieldType, options, required: payload.required === true }; if (before.id) statements.push(scoped.prepare("UPDATE fdp_custom_fields SET name = ?, field_type = ?, options_json = ?, required = ? WHERE workspace_id = ? AND id = ?").bind(name, fieldType, JSON.stringify(options), after.required ? 1 : 0, workspaceId, entityId)); else statements.push(scoped.prepare("INSERT INTO fdp_custom_fields (id, workspace_id, name, field_key, field_type, options_json, required, position) VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT coalesce(max(position),0)+1000 FROM fdp_custom_fields WHERE workspace_id = ?))").bind(entityId, workspaceId, name, key, fieldType, JSON.stringify(options), after.required ? 1 : 0, workspaceId)); }
      } else if (action === "template.save" || action === "template.delete") {
        entityType = "process_template"; entityId = text(payload.id, 120) || crypto.randomUUID(); before = await scoped.prepare("SELECT id, name, process_type, active FROM fdp_process_templates WHERE workspace_id = ? AND id = ?").bind(workspaceId, entityId).first<Row>() ?? {};
        if (action.endsWith("delete")) { after = { deleted: true }; statements.push(scoped.prepare("DELETE FROM fdp_process_templates WHERE workspace_id = ? AND id = ?").bind(workspaceId, entityId)); } else { const name = text(payload.name, 80); const processType = validProcessType(payload.processType); const checklist = Array.isArray(payload.checklist) ? payload.checklist.map((item) => text(item, 180)).filter(Boolean).slice(0, 30) : []; const days = Math.min(60, Math.max(1, Number(payload.defaultSlaDays) || 3)); if (!name || !checklist.length) throw ApiError.badRequest("Informe nome e etapas do template.", "TEMPLATE_INPUT_REQUIRED"); after = { id: entityId, name, processType, description: text(payload.description, 500), checklist, defaultSlaDays: days, active: payload.active !== false }; if (before.id) statements.push(scoped.prepare("UPDATE fdp_process_templates SET name = ?, process_type = ?, description = ?, checklist_json = ?, default_sla_days = ?, active = ? WHERE workspace_id = ? AND id = ?").bind(name, processType, after.description, JSON.stringify(checklist), days, after.active ? 1 : 0, workspaceId, entityId)); else statements.push(scoped.prepare("INSERT INTO fdp_process_templates (id, workspace_id, name, process_type, description, checklist_json, default_sla_days, active, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT coalesce(max(position),0)+1000 FROM fdp_process_templates WHERE workspace_id = ?))").bind(entityId, workspaceId, name, processType, after.description, JSON.stringify(checklist), days, after.active ? 1 : 0, workspaceId)); }
      } else if (action === "calendar.update") {
        entityType = "workspace_calendar"; before = await scoped.prepare("SELECT business_days_json, day_start, day_end, realtime_seconds FROM fdp_workspace_settings WHERE workspace_id = ?").bind(workspaceId).first<Row>() ?? {}; const days = Array.isArray(payload.businessDays) ? [...new Set(payload.businessDays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))] : []; if (!days.length) throw ApiError.badRequest("Selecione ao menos um dia útil.", "BUSINESS_DAYS_REQUIRED"); const dayStart = /^\d{2}:\d{2}$/u.test(text(payload.dayStart, 5)) ? text(payload.dayStart, 5) : "08:00"; const dayEnd = /^\d{2}:\d{2}$/u.test(text(payload.dayEnd, 5)) ? text(payload.dayEnd, 5) : "18:00"; after = { businessDays: days, dayStart, dayEnd, realtimeSeconds: Math.min(120, Math.max(5, Number(payload.realtimeSeconds) || 30)) }; statements.push(scoped.prepare("INSERT INTO fdp_workspace_settings (workspace_id, business_days_json, day_start, day_end, realtime_seconds) VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET business_days_json = excluded.business_days_json, day_start = excluded.day_start, day_end = excluded.day_end, realtime_seconds = excluded.realtime_seconds, updated_at = now()").bind(workspaceId, JSON.stringify(days), dayStart, dayEnd, after.realtimeSeconds));
      } else if (action === "holiday.save" || action === "holiday.delete") {
        entityType = "business_holiday"; const holidayDate = validDate(payload.date); if (!holidayDate) throw ApiError.badRequest("Informe a data do feriado.", "HOLIDAY_DATE_REQUIRED"); entityId = holidayDate; before = await scoped.prepare("SELECT holiday_date, name FROM fdp_business_holidays WHERE workspace_id = ? AND holiday_date = ?").bind(workspaceId, entityId).first<Row>() ?? {}; if (action.endsWith("delete")) { after = { deleted: true }; statements.push(scoped.prepare("DELETE FROM fdp_business_holidays WHERE workspace_id = ? AND holiday_date = ?").bind(workspaceId, entityId)); } else { after = { date: entityId, name: text(payload.name, 100) || "Feriado" }; statements.push(scoped.prepare("INSERT INTO fdp_business_holidays (workspace_id, holiday_date, name) VALUES (?, ?, ?) ON CONFLICT(workspace_id, holiday_date) DO UPDATE SET name = excluded.name").bind(workspaceId, entityId, after.name)); }
      } else if (action === "sla.save") {
        entityType = "sla_policy"; const processType = validProcessType(payload.processType) || "OUTROS"; entityId = processType; before = await scoped.prepare("SELECT process_type, target_business_days, warning_business_days, active FROM fdp_sla_policies WHERE workspace_id = ? AND process_type = ?").bind(workspaceId, processType).first<Row>() ?? {}; const target = Math.min(60, Math.max(1, Number(payload.targetBusinessDays) || 3)); const warning = Math.min(target, Math.max(0, Number(payload.warningBusinessDays) || 0)); after = { processType, targetBusinessDays: target, warningBusinessDays: warning, active: payload.active !== false }; statements.push(scoped.prepare("INSERT INTO fdp_sla_policies (id, workspace_id, process_type, target_business_days, warning_business_days, active) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, process_type) DO UPDATE SET target_business_days = excluded.target_business_days, warning_business_days = excluded.warning_business_days, active = excluded.active").bind(crypto.randomUUID(), workspaceId, processType, target, warning, after.active ? 1 : 0));
      } else if (action === "rule.save" || action === "rule.delete") {
        entityType = "automation_rule"; entityId = text(payload.id, 120) || crypto.randomUUID();
        before = await scoped.prepare("SELECT id, name, trigger, condition_json, action_json, enabled FROM fdp_automation_rules WHERE workspace_id = ? AND id = ?").bind(workspaceId, entityId).first<Row>() ?? {};
        if (action.endsWith("delete")) {
          after = { deleted: true }; statements.push(scoped.prepare("DELETE FROM fdp_automation_rules WHERE workspace_id = ? AND id = ?").bind(workspaceId, entityId));
        } else {
          const name = text(payload.name, 120); const requestedTrigger = text(payload.trigger, 40);
          const triggers = new Set(["card.created", "card.moved", "assignee.added", "checklist.completed", "sla.tick"]);
          if (!triggers.has(requestedTrigger)) throw ApiError.badRequest("Gatilho de automação inválido.", "RULE_TRIGGER_INVALID");
          const condition = payload.condition && typeof payload.condition === "object" && !Array.isArray(payload.condition) ? payload.condition as Row : {};
          const ruleAction = payload.ruleAction && typeof payload.ruleAction === "object" && !Array.isArray(payload.ruleAction) ? payload.ruleAction as Row : {};
          const conditionKeys: Record<string, Set<string>> = { "card.created": new Set(["processType", "priority"]), "card.moved": new Set(["listKind", "fromListKind"]), "assignee.added": new Set(["assignee"]), "checklist.completed": new Set(["allItems"]), "sla.tick": new Set() };
          if (Object.keys(condition).some((key) => !conditionKeys[requestedTrigger].has(key))) throw ApiError.badRequest("A condição contém campo incompatível com o gatilho.", "RULE_CONDITION_INVALID");
          if (Object.values(condition).some((value) => value !== null && typeof value === "object")) throw ApiError.badRequest("A condição aceita apenas valores simples.", "RULE_CONDITION_VALUE_INVALID");
          if (condition.processType !== undefined) condition.processType = validProcessType(condition.processType);
          if (Object.keys(ruleAction).some((key) => !["moveTo", "slaStatus", "labelId"].includes(key))) throw ApiError.badRequest("A ação contém campo não suportado.", "RULE_ACTION_INVALID");
          if (Object.values(ruleAction).some((value) => typeof value !== "string" || value.length > 120)) throw ApiError.badRequest("A ação aceita somente identificadores curtos.", "RULE_ACTION_VALUE_INVALID");
          if (ruleAction.slaStatus !== undefined && !["safe", "warning", "breached", "paused", "recalculate"].includes(text(ruleAction.slaStatus, 30))) throw ApiError.badRequest("Estado de SLA inválido.", "RULE_SLA_STATUS_INVALID");
          if (ruleAction.labelId !== undefined && !await scoped.prepare("SELECT 1 FROM fdp_labels WHERE workspace_id = ? AND id = ?").bind(workspaceId, text(ruleAction.labelId, 120)).first()) throw ApiError.badRequest("Etiqueta da automação não pertence ao workspace.", "RULE_LABEL_INVALID");
          if (ruleAction.moveTo !== undefined && !await scoped.prepare("SELECT 1 FROM fdp_lists WHERE workspace_id = ? AND kind = ?").bind(workspaceId, text(ruleAction.moveTo, 80)).first()) throw ApiError.badRequest("A coluna de destino não pertence ao workspace.", "RULE_LIST_INVALID");
          if (!name || !Object.keys(ruleAction).length) throw ApiError.badRequest("Informe nome e ao menos uma ação suportada.", "RULE_INPUT_REQUIRED");
          after = { id: entityId, name, trigger: requestedTrigger, condition, action: ruleAction, enabled: payload.enabled !== false };
          if (before.id) statements.push(scoped.prepare("UPDATE fdp_automation_rules SET name = ?, trigger = ?, condition_json = ?, action_json = ?, enabled = ? WHERE workspace_id = ? AND id = ?").bind(name, requestedTrigger, JSON.stringify(condition), JSON.stringify(ruleAction), after.enabled ? 1 : 0, workspaceId, entityId));
          else statements.push(scoped.prepare("INSERT INTO fdp_automation_rules (id, workspace_id, name, trigger, condition_json, action_json, enabled, position) VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT coalesce(max(position),0)+1000 FROM fdp_automation_rules WHERE workspace_id = ?))").bind(entityId, workspaceId, name, requestedTrigger, JSON.stringify(condition), JSON.stringify(ruleAction), after.enabled ? 1 : 0, workspaceId));
        }
      } else if (action === "module.set") {
        entityType = "workspace_module_grant"; entityId = text(payload.moduleKey, 80); if (!await scoped.prepare("SELECT key FROM fdp_modules WHERE key = ?").bind(entityId).first()) throw ApiError.notFound("Módulo não encontrado.", "MODULE_NOT_FOUND"); before = await scoped.prepare("SELECT module_key, granted, reason, expires_at FROM fdp_workspace_module_grants WHERE workspace_id = ? AND module_key = ?").bind(workspaceId, entityId).first<Row>() ?? {}; if (payload.granted == null) { after = { inheritedFromPlan: true }; statements.push(scoped.prepare("DELETE FROM fdp_workspace_module_grants WHERE workspace_id = ? AND module_key = ?").bind(workspaceId, entityId)); } else { after = { moduleKey: entityId, granted: payload.granted === true, expiresAt: text(payload.expiresAt, 30) || null }; statements.push(scoped.prepare("INSERT INTO fdp_workspace_module_grants (workspace_id, module_key, granted, reason, granted_by, expires_at) VALUES (?, ?, ?, ?, ?, ?::timestamptz) ON CONFLICT(workspace_id, module_key) DO UPDATE SET granted = excluded.granted, reason = excluded.reason, granted_by = excluded.granted_by, expires_at = excluded.expires_at, updated_at = now()").bind(workspaceId, entityId, after.granted ? 1 : 0, reason, platform.email, after.expiresAt)); }
      } else if (action === "member.scope") {
        entityType = "member_access"; entityId = text(payload.userId, 120); const role = text(payload.role, 20); if (!roles.has(role)) throw ApiError.badRequest("Papel inválido.", "INVALID_ROLE"); const member = await scoped.prepare("SELECT member.role, (workspace.owner_user_id = member.user_id) AS is_owner FROM fdp_workspace_members member JOIN fdp_workspaces workspace ON workspace.id = member.workspace_id WHERE member.workspace_id = ? AND member.user_id = ?").bind(workspaceId, entityId).first<Row>(); if (!member) throw ApiError.notFound("Membro não encontrado.", "MEMBER_NOT_FOUND"); if (truthy(member.is_owner) && role !== "admin") throw ApiError.badRequest("O proprietário precisa permanecer administrador.", "OWNER_MUST_REMAIN_ADMIN"); const companyIds = Array.isArray(payload.companyIds) ? [...new Set(payload.companyIds.map((item) => text(item, 120)).filter(Boolean))] : []; if (companyIds.length) { const valid = await scoped.prepare(`SELECT id FROM fdp_companies WHERE workspace_id = ? AND id IN (${companyIds.map(() => "?").join(",")})`).bind(workspaceId, ...companyIds).all(); if (valid.results.length !== companyIds.length) throw ApiError.badRequest("Empresa inválida no escopo.", "INVALID_COMPANY_SCOPE"); } before = { role: member.role }; after = { role, companyIds }; statements.push(scoped.prepare("UPDATE fdp_workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?").bind(role, workspaceId, entityId), scoped.prepare("DELETE FROM fdp_member_company_access WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, entityId), ...companyIds.map((companyId) => scoped.prepare("INSERT INTO fdp_member_company_access (workspace_id, user_id, company_id) VALUES (?, ?, ?)").bind(workspaceId, entityId, companyId)));
      } else if (action === "member.module.set") {
        entityType = "member_module_grant"; const userId = text(payload.userId, 120); const moduleKey = text(payload.moduleKey, 80); entityId = `${userId}:${moduleKey}`;
        if (!await scoped.prepare("SELECT 1 FROM fdp_workspace_members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, userId).first()) throw ApiError.notFound("Membro não encontrado.", "MEMBER_NOT_FOUND");
        const moduleAccess = await scoped.prepare(`SELECT module.key, module.status, (plan_module.module_key IS NOT NULL) AS in_plan, workspace_grant.granted
          FROM fdp_modules module
          LEFT JOIN fdp_plan_modules plan_module ON plan_module.module_key = module.key AND plan_module.plan_id = (SELECT plan_id FROM fdp_workspace_subscriptions WHERE workspace_id = ?)
          LEFT JOIN fdp_workspace_module_grants workspace_grant ON workspace_grant.workspace_id = ? AND workspace_grant.module_key = module.key
          WHERE module.key = ?`).bind(workspaceId, workspaceId, moduleKey).first<Row>();
        if (!moduleAccess) throw ApiError.notFound("Módulo não encontrado.", "MODULE_NOT_FOUND");
        const granted = payload.granted == null ? null : payload.granted === true;
        const workspaceAllows = moduleAccess.granted == null ? truthy(moduleAccess.in_plan) : truthy(moduleAccess.granted);
        if (granted === true && (!workspaceAllows || text(moduleAccess.status) !== "active")) throw new ApiError(409, "MODULE_NOT_CONTRACTED", "O módulo precisa estar ativo e liberado para o workspace antes da concessão individual.");
        before = await scoped.prepare("SELECT user_id, module_key, granted, reason FROM fdp_member_module_grants WHERE workspace_id = ? AND user_id = ? AND module_key = ?").bind(workspaceId, userId, moduleKey).first<Row>() ?? {};
        after = { userId, moduleKey, granted };
        if (granted == null) statements.push(scoped.prepare("DELETE FROM fdp_member_module_grants WHERE workspace_id = ? AND user_id = ? AND module_key = ?").bind(workspaceId, userId, moduleKey));
        else statements.push(scoped.prepare(`INSERT INTO fdp_member_module_grants (workspace_id, user_id, module_key, granted, reason, granted_by)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, user_id, module_key)
          DO UPDATE SET granted = EXCLUDED.granted, reason = EXCLUDED.reason, granted_by = EXCLUDED.granted_by, updated_at = now()`)
          .bind(workspaceId, userId, moduleKey, granted, reason, platform.userId));
      } else if (action === "api_key.revoke") {
        entityType = "api_key"; entityId = text(payload.id, 120); before = await scoped.prepare("SELECT id, name, prefix, status FROM fdp_api_keys WHERE workspace_id = ? AND id = ?").bind(workspaceId, entityId).first<Row>() ?? {}; if (!before.id) throw ApiError.notFound("Chave de API não encontrada.", "API_KEY_NOT_FOUND"); after = { ...before, status: "revoked" }; statements.push(scoped.prepare("UPDATE fdp_api_keys SET status = 'revoked', revoked_at = now(), revoked_by = ? WHERE workspace_id = ? AND id = ?").bind(platform.email, workspaceId, entityId));
      } else if (action === "webhook.status") {
        entityType = "webhook_endpoint"; entityId = text(payload.id, 120); const status = text(payload.status, 20); if (!["active", "paused", "disabled"].includes(status)) throw ApiError.badRequest("Status de webhook inválido.", "INVALID_WEBHOOK_STATUS"); before = await scoped.prepare("SELECT id, name, status FROM fdp_webhook_endpoints WHERE workspace_id = ? AND id = ?").bind(workspaceId, entityId).first<Row>() ?? {}; if (!before.id) throw ApiError.notFound("Webhook não encontrado.", "WEBHOOK_NOT_FOUND"); after = { ...before, status }; statements.push(scoped.prepare("UPDATE fdp_webhook_endpoints SET status = ?, updated_at = now() WHERE workspace_id = ? AND id = ?").bind(status, workspaceId, entityId)); if (status === "disabled") statements.push(scoped.prepare("UPDATE fdp_webhook_deliveries SET status = 'canceled', updated_at = now() WHERE workspace_id = ? AND endpoint_id = ? AND status IN ('pending','failed')").bind(workspaceId, entityId));
      } else throw ApiError.badRequest("Ação de configuração inválida.", "INVALID_CONFIGURATION_ACTION");

      statements.push(...audit(scoped, platform, request, workspaceId, `platform.${action}`, entityType, entityId, before, after, reason));
      await scoped.batch(statements);
      return Response.json({ ok: true, action, entityId, configuration: await configuration(workspaceId, platform.userId) });
    });
  } catch (error) { return apiError(error); }
}
