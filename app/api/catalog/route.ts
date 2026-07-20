import { apiError, getApiUser, text, validDate } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";

const colors = new Set(["#dc2626", "#ea580c", "#d97706", "#16a34a", "#0891b2", "#2563eb", "#7c3aed", "#64748b"]);

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const resource = text(body.resource, 40);
    const operation = text(body.operation, 20) || "create";
    const id = text(body.id, 160);
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin"]);

    if (resource === "label") {
      if (operation === "delete") {
        await d1.prepare("DELETE FROM fdp_labels WHERE id = ? AND workspace_id = ?").bind(id, workspace.id).run();
      } else {
        const name = text(body.name, 40);
        if (!name) return Response.json({ error: "Informe o nome da etiqueta." }, { status: 400 });
        const color = colors.has(String(body.color)) ? String(body.color) : "#64748b";
        if (id) await d1.prepare("UPDATE fdp_labels SET name = ?, color = ? WHERE id = ? AND workspace_id = ?").bind(name, color, id, workspace.id).run();
        else {
          const position = await d1.prepare("SELECT COALESCE(MAX(position), 0) AS value FROM fdp_labels WHERE workspace_id = ?").bind(workspace.id).first<{ value: number }>();
          await d1.prepare("INSERT INTO fdp_labels (id, workspace_id, name, color, position) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), workspace.id, name, color, Number(position?.value ?? 0) + 1000).run();
        }
      }
    } else if (resource === "field") {
      if (operation === "delete") await d1.prepare("DELETE FROM fdp_custom_fields WHERE id = ? AND workspace_id = ?").bind(id, workspace.id).run();
      else {
        const name = text(body.name, 60);
        const fieldKey = text(body.fieldKey, 60).toLowerCase().replace(/[^a-z0-9_]/g, "_");
        const fieldType = ["text", "number", "date", "select"].includes(String(body.fieldType)) ? String(body.fieldType) : "text";
        const options = Array.isArray(body.options) ? body.options.map((item) => text(item, 60)).filter(Boolean).slice(0, 20) : [];
        if (!name || !fieldKey) return Response.json({ error: "Informe nome e identificador do campo." }, { status: 400 });
        if (id) await d1.prepare("UPDATE fdp_custom_fields SET name = ?, field_type = ?, options_json = ?, required = ? WHERE id = ? AND workspace_id = ?").bind(name, fieldType, JSON.stringify(options), body.required ? 1 : 0, id, workspace.id).run();
        else {
          const position = await d1.prepare("SELECT COALESCE(MAX(position), 0) AS value FROM fdp_custom_fields WHERE workspace_id = ?").bind(workspace.id).first<{ value: number }>();
          await d1.prepare("INSERT INTO fdp_custom_fields (id, workspace_id, name, field_key, field_type, options_json, required, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), workspace.id, name, fieldKey, fieldType, JSON.stringify(options), body.required ? 1 : 0, Number(position?.value ?? 0) + 1000).run();
        }
      }
    } else if (resource === "template") {
      if (operation === "delete") await d1.prepare("DELETE FROM fdp_process_templates WHERE id = ? AND workspace_id = ?").bind(id, workspace.id).run();
      else {
        const name = text(body.name, 80);
        const processType = text(body.processType, 40).toUpperCase() || "OUTROS";
        const checklist = Array.isArray(body.checklist) ? body.checklist.map((item) => text(item, 180)).filter(Boolean).slice(0, 30) : [];
        const days = Math.min(60, Math.max(1, Number(body.defaultSlaDays) || 3));
        if (!name || !checklist.length) return Response.json({ error: "Informe nome e etapas do template." }, { status: 400 });
        if (id) await d1.prepare("UPDATE fdp_process_templates SET name = ?, process_type = ?, description = ?, checklist_json = ?, default_sla_days = ?, active = ? WHERE id = ? AND workspace_id = ?").bind(name, processType, text(body.description, 500), JSON.stringify(checklist), days, body.active === false ? 0 : 1, id, workspace.id).run();
        else {
          const position = await d1.prepare("SELECT COALESCE(MAX(position), 0) AS value FROM fdp_process_templates WHERE workspace_id = ?").bind(workspace.id).first<{ value: number }>();
          await d1.prepare("INSERT INTO fdp_process_templates (id, workspace_id, name, process_type, description, checklist_json, default_sla_days, active, position) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)").bind(crypto.randomUUID(), workspace.id, name, processType, text(body.description, 500), JSON.stringify(checklist), days, Number(position?.value ?? 0) + 1000).run();
        }
      }
    } else if (resource === "holiday") {
      const date = validDate(body.date);
      if (!date) return Response.json({ error: "Informe a data do feriado." }, { status: 400 });
      if (operation === "delete") await d1.prepare("DELETE FROM fdp_business_holidays WHERE workspace_id = ? AND holiday_date = ?").bind(workspace.id, date).run();
      else await d1.prepare("INSERT INTO fdp_business_holidays (workspace_id, holiday_date, name) VALUES (?, ?, ?) ON CONFLICT(workspace_id, holiday_date) DO UPDATE SET name = excluded.name").bind(workspace.id, date, text(body.name, 100) || "Feriado").run();
    } else if (resource === "sla") {
      const processType = text(body.processType, 40).toUpperCase();
      const target = Math.min(60, Math.max(1, Number(body.targetBusinessDays) || 3));
      const warningValue = Number(body.warningBusinessDays);
      const warning = Math.min(target, Math.max(0, Number.isFinite(warningValue) ? warningValue : 1));
      await d1.prepare(`INSERT INTO fdp_sla_policies (id, workspace_id, process_type, target_business_days, warning_business_days, active)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, process_type) DO UPDATE SET target_business_days = excluded.target_business_days, warning_business_days = excluded.warning_business_days, active = excluded.active`).bind(crypto.randomUUID(), workspace.id, processType || "OUTROS", target, warning, body.active === false ? 0 : 1).run();
    } else if (resource === "settings") {
      const businessDays = Array.isArray(body.businessDays) ? body.businessDays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6) : [1, 2, 3, 4, 5];
      if (!businessDays.length) return Response.json({ error: "Selecione ao menos um dia útil." }, { status: 400 });
      const dayStart = /^\d{2}:\d{2}$/.test(String(body.dayStart)) ? String(body.dayStart) : "08:00";
      const dayEnd = /^\d{2}:\d{2}$/.test(String(body.dayEnd)) ? String(body.dayEnd) : "18:00";
      const realtime = Math.min(120, Math.max(5, Number(body.realtimeSeconds) || 30));
      await d1.prepare("UPDATE fdp_workspace_settings SET business_days_json = ?, day_start = ?, day_end = ?, realtime_seconds = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ?").bind(JSON.stringify(businessDays), dayStart, dayEnd, realtime, workspace.id).run();
    } else if (resource === "integration") {
      const config = body.config && typeof body.config === "object" && !Array.isArray(body.config) ? body.config as Record<string, unknown> : {};
      if (Object.keys(config).some((key) => /token|password|secret|senha|chave/i.test(key))) return Response.json({ error: "Credenciais secretas devem ser configuradas no ambiente seguro, não nesta tela." }, { status: 400 });
      const status = ["needs_credentials", "paused"].includes(String(body.status)) ? String(body.status) : "needs_credentials";
      await d1.prepare("UPDATE fdp_integrations SET config_json = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND workspace_id = ?").bind(JSON.stringify(config), status, id, workspace.id).run();
    } else if (resource === "rule") {
      if (operation === "delete") await d1.prepare("DELETE FROM fdp_automation_rules WHERE id = ? AND workspace_id = ?").bind(id, workspace.id).run();
      else {
        const name = text(body.name, 120);
        const trigger = ["card.created", "card.moved", "assignee.added", "checklist.completed", "sla.tick"].includes(String(body.trigger)) ? String(body.trigger) : "card.created";
        const condition = body.condition && typeof body.condition === "object" ? body.condition : {};
        const action = body.action && typeof body.action === "object" ? body.action : {};
        if (!name) return Response.json({ error: "Informe o nome da automação." }, { status: 400 });
        if (id) await d1.prepare("UPDATE fdp_automation_rules SET name = ?, trigger = ?, condition_json = ?, action_json = ?, enabled = ? WHERE id = ? AND workspace_id = ?").bind(name, trigger, JSON.stringify(condition), JSON.stringify(action), body.enabled === false ? 0 : 1, id, workspace.id).run();
        else {
          const position = await d1.prepare("SELECT COALESCE(MAX(position), 0) AS value FROM fdp_automation_rules WHERE workspace_id = ?").bind(workspace.id).first<{ value: number }>();
          await d1.prepare("INSERT INTO fdp_automation_rules (id, workspace_id, name, trigger, condition_json, action_json, enabled, position) VALUES (?, ?, ?, ?, ?, ?, 1, ?)").bind(crypto.randomUUID(), workspace.id, name, trigger, JSON.stringify(condition), JSON.stringify(action), Number(position?.value ?? 0) + 1000).run();
        }
      }
    } else {
      return Response.json({ error: "Configuração inválida." }, { status: 400 });
    }

    await recordActivity(workspace.id, null, auth.user.email, `catalog.${resource}.${operation}`, { id });
    return Response.json(await getWorkspaceSnapshot(auth.user));
  } catch (error) {
    return apiError(error);
  }
}
