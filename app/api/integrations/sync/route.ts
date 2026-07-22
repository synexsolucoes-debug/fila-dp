import { getD1 } from "@/db";
import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";

const supported = new Set(["email", "whatsapp", "teams", "drive", "onedrive", "erp"]);
const microsoftChannels = new Set(["teams", "onedrive"]);

type ExternalInboxItem = {
  senderName: string;
  subject: string;
  body: string;
};

type ExternalHrMetric = {
  companyId: string;
  period: string;
  headcount: number;
  admissions: number;
  terminations: number;
  payrollCost: number;
  externalId: string;
};

function asRecord(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stripHtml(value: string) {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

async function getMicrosoftGraphToken() {
  const clientId = process.env.FDP_MICROSOFT_CLIENT_ID ?? "";
  const tenantId = process.env.FDP_MICROSOFT_TENANT_ID ?? "";
  const clientSecret = process.env.FDP_MICROSOFT_CLIENT_SECRET ?? "";
  if (!clientId || !tenantId || !clientSecret) return "";

  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json() as { access_token?: string; error_description?: string };
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || `Microsoft Graph respondeu com status ${response.status}.`);
  }
  return payload.access_token;
}

async function getSankhyaToken() {
  const clientId = process.env.FDP_SANKHYA_CLIENT_ID ?? "";
  const clientSecret = process.env.FDP_SANKHYA_CLIENT_SECRET ?? "";
  const xToken = process.env.FDP_SANKHYA_X_TOKEN ?? "";
  if (!clientId || !clientSecret || !xToken) return "";
  const baseUrl = (process.env.FDP_SANKHYA_BASE_URL || "https://api.sankhya.com.br").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/authenticate`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "X-Token": xToken },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json() as { access_token?: string; error?: string; message?: string };
  if (!response.ok || !payload.access_token) throw new Error(payload.message || payload.error || `Sankhya respondeu com status ${response.status}.`);
  return payload.access_token;
}

function mapExternalItems(channel: string, payload: Record<string, unknown>): ExternalInboxItem[] {
  const responseBody = asRecord(payload.responseBody);
  const source = Array.isArray(payload.items) ? payload.items : Array.isArray(payload.value) ? payload.value : Array.isArray(payload.records) ? payload.records : Array.isArray(responseBody.records) ? responseBody.records : [];
  return source.slice(0, 100).map((rawItem) => {
    const item = asRecord(rawItem);
    if (channel === "teams") {
      const from = asRecord(item.from);
      const user = asRecord(from.user);
      const application = asRecord(from.application);
      const body = asRecord(item.body);
      return {
        senderName: text(user.displayName ?? application.displayName, 160) || "Microsoft Teams",
        subject: text(item.subject, 240) || "Mensagem do Teams",
        body: stripHtml(text(body.content ?? item.content, 5000)),
      };
    }
    if (channel === "onedrive") {
      const parentReference = asRecord(item.parentReference);
      return {
        senderName: "Microsoft OneDrive",
        subject: text(item.name, 240) || "Arquivo do OneDrive",
        body: text(item.webUrl ?? parentReference.path, 5000),
      };
    }
    return {
      senderName: text(item.senderName ?? item.from, 160) || "Integração",
      subject: text(item.subject ?? item.title, 240) || `Atualização via ${channel}`,
      body: text(item.body ?? item.text, 5000),
    };
  }).filter((item) => item.subject || item.body);
}

function mapExternalMetrics(payload: Record<string, unknown>, fieldMap: Record<string, string> = {}): ExternalHrMetric[] {
  const responseBody = asRecord(payload.responseBody);
  const source = Array.isArray(payload.metrics) ? payload.metrics : Array.isArray(payload.records) ? payload.records : Array.isArray(responseBody.records) ? responseBody.records : [];
  return source.slice(0, 120).map((rawItem) => {
    const item = asRecord(rawItem);
    const numberValue = (value: unknown) => {
      const normalized = typeof value === "string" && value.includes(",") ? value.replace(/\./g, "").replace(",", ".") : value;
      const parsed = Number(normalized);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    };
    const valueFor = (key: string, aliases: string[]) => {
      const keys = [fieldMap[key], ...aliases].filter(Boolean) as string[];
      for (const candidate of keys) {
        const found = item[candidate] ?? item[candidate.toUpperCase()] ?? item[candidate.toLowerCase()];
        if (found !== undefined && found !== null && found !== "") return found;
      }
      return "";
    };
    const rawPeriod = text(valueFor("period", ["period", "competencia", "REFERENCIA", "PERREF"]), 20);
    const period = /^\d{4}-\d{2}/.test(rawPeriod) ? rawPeriod.slice(0, 7) : /^(\d{2})\/(\d{4})$/.test(rawPeriod) ? `${rawPeriod.slice(3, 7)}-${rawPeriod.slice(0, 2)}` : "";
    return {
      companyId: text(valueFor("companyId", ["companyId", "company_id", "CODEMP", "COD_EMPRESA"]), 120),
      period,
      headcount: Math.round(numberValue(valueFor("headcount", ["headcount", "colaboradores", "HEADCOUNT"]))),
      admissions: Math.round(numberValue(valueFor("admissions", ["admissions", "admissoes", "ADMISSOES"]))),
      terminations: Math.round(numberValue(valueFor("terminations", ["terminations", "rescisoes", "desligamentos", "DESLIGAMENTOS"]))),
      payrollCost: numberValue(valueFor("payrollCost", ["payrollCost", "payroll_cost", "custoFolha", "CUSTOFOLHA"])),
      externalId: text(valueFor("externalId", ["externalId", "external_id", "id", "ID"]), 120),
    };
  }).filter((item) => item.companyId && /^\d{4}-\d{2}$/.test(item.period));
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  let d1: ReturnType<typeof getD1> | null = null;
  let integrationId = "";
  try {
    const body = await request.json() as { channel?: string };
    const channel = String(body.channel ?? "").toLowerCase();
    if (!supported.has(channel)) return Response.json({ error: "Canal não suportado." }, { status: 400 });

    const context = await getWorkspaceContext(auth.user);
    d1 = context.d1;
    const { workspace } = context;
    requireWorkspaceRole(workspace.role, ["admin", "member"]);

    const integration = await d1!.prepare("SELECT id, config_json FROM fdp_integrations WHERE workspace_id = ? AND channel = ?").bind(workspace.id, channel).first<{ id: string; config_json: string }>();
    if (!integration) return Response.json({ error: `A integração ${channel} ainda não foi inicializada neste workspace. Abra as configurações e salve a integração uma vez antes de sincronizar.`, code: "INTEGRATION_NOT_INITIALIZED", details: { channel } }, { status: 409 });
    integrationId = integration.id;

    const config = JSON.parse(integration.config_json || "{}") as Record<string, unknown>;
    const endpoint = text(config.endpoint, 500) || text(process.env[`FDP_${channel.toUpperCase()}_ENDPOINT`], 500);
    const explicitToken = String(process.env[`FDP_${channel.toUpperCase()}_TOKEN`] ?? "");
    const microsoftReady = Boolean(process.env.FDP_MICROSOFT_CLIENT_ID && process.env.FDP_MICROSOFT_TENANT_ID && process.env.FDP_MICROSOFT_CLIENT_SECRET);
    const sankhyaReady = Boolean(process.env.FDP_SANKHYA_CLIENT_ID && process.env.FDP_SANKHYA_CLIENT_SECRET && process.env.FDP_SANKHYA_X_TOKEN);
    const token = explicitToken
      || (microsoftChannels.has(channel) && microsoftReady ? await getMicrosoftGraphToken() : "")
      || (channel === "erp" && sankhyaReady ? await getSankhyaToken() : "");
    if (!endpoint || !token) {
      const tokenRequirement = microsoftChannels.has(channel)
        ? `a variável FDP_${channel.toUpperCase()}_TOKEN ou FDP_MICROSOFT_CLIENT_ID, FDP_MICROSOFT_TENANT_ID e FDP_MICROSOFT_CLIENT_SECRET`
        : channel === "erp"
          ? "FDP_ERP_TOKEN ou FDP_SANKHYA_CLIENT_ID, FDP_SANKHYA_CLIENT_SECRET e FDP_SANKHYA_X_TOKEN"
          : `a variável FDP_${channel.toUpperCase()}_TOKEN`;
      const missing: string[] = [];
      if (!endpoint) missing.push(`o endpoint (salvo na integração ou FDP_${channel.toUpperCase()}_ENDPOINT)`);
      if (!token) missing.push(tokenRequirement);
      return Response.json({
        error: `Integração ${channel} incompleta. Configure ${missing.join(" e ")} antes de sincronizar.`,
        code: "INTEGRATION_CONFIGURATION_MISSING",
        details: { channel, endpointConfigured: Boolean(endpoint), tokenConfigured: Boolean(token), microsoftCredentialsConfigured: microsoftReady },
      }, { status: 409 });
    }

    const rawRequestBody = channel === "erp" ? (config.requestBody ?? process.env.FDP_SANKHYA_REQUEST_BODY) : undefined;
    const requestBody = rawRequestBody && typeof rawRequestBody === "object"
      ? JSON.stringify(rawRequestBody)
      : typeof rawRequestBody === "string" && rawRequestBody.trim() ? rawRequestBody : undefined;
    const isSankhyaEndpoint = channel === "erp" && /sankhya\.com\.br|service\.sbr/i.test(endpoint);
    const method = channel === "erp" && (isSankhyaEndpoint || requestBody) ? "POST" : "GET";
    const response = await fetch(endpoint, {
      method,
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(requestBody ? { "Content-Type": "application/json" } : {}) },
      body: requestBody,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const responseText = await response.text();
      let providerMessage = "";
      try {
        const providerPayload = JSON.parse(responseText) as Record<string, unknown>;
        const providerError = asRecord(providerPayload.error);
        providerMessage = text(providerError.message ?? providerPayload.message ?? providerPayload.error_description, 500);
      } catch {
        providerMessage = responseText.replace(/\s+/g, " ").trim().slice(0, 500);
      }
      if (response.status === 403 && channel === "teams") {
        const isChatEndpoint = /\/chats\//i.test(endpoint);
        const permissionHint = isChatEndpoint
          ? "ChatMessage.Read.All (Application) — ou Chat.Read.All como permissão superior"
          : "ChannelMessage.Read.All (Application) — ou ChannelMessage.Read.Group com consentimento específico do recurso";
        const endpointHint = isChatEndpoint
          ? "Você configurou um endpoint de chat; se a intenção era ler um canal, use /teams/TEAM_ID/channels/CHANNEL_ID/messages"
          : "confirme se o endpoint aponta para o time e canal corretos";
        throw new Error(`Teams recusou a chamada (403). Conceda Admin consent à permissão ${permissionHint} no Microsoft Graph e ${endpointHint}.${providerMessage ? ` Detalhe: ${providerMessage}` : ""}`);
      }
      throw new Error(`O provedor respondeu com status ${response.status}.${providerMessage ? ` Detalhe: ${providerMessage}` : ""}`);
    }

    const payload = await response.json() as Record<string, unknown>;
    const items = mapExternalItems(channel, payload);
    if (items.length) await d1!.batch(items.map((item) => d1!.prepare("INSERT INTO fdp_workspace_inbox_items (id, workspace_id, channel, sender_name, subject, body, status) VALUES (?, ?, ?, ?, ?, ?, 'new')").bind(crypto.randomUUID(), workspace.id, channel, item.senderName, item.subject, item.body)));
    const fieldMap = channel === "erp"
      ? (() => {
        try {
          const configured = config.metricFieldMap ?? process.env.FDP_SANKHYA_METRIC_FIELD_MAP;
          const parsed = typeof configured === "string" ? JSON.parse(configured) : configured;
          return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
        } catch { return {}; }
      })()
      : {};
    const metrics = channel === "erp" ? mapExternalMetrics(payload, fieldMap) : [];
    let metricsSynced = 0;
    for (const metric of metrics) {
      const company = await d1!.prepare("SELECT id FROM fdp_companies WHERE workspace_id = ? AND (id = ? OR external_code = ?)").bind(workspace.id, metric.companyId, metric.companyId).first<{ id: string }>();
      if (!company) continue;
      await d1!.prepare(`INSERT INTO fdp_hr_metrics
        (id, workspace_id, company_id, period, headcount, admissions, terminations, payroll_cost, source, external_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sankhya', ?)
        ON CONFLICT(workspace_id, company_id, period) DO UPDATE SET headcount = excluded.headcount,
          admissions = excluded.admissions, terminations = excluded.terminations, payroll_cost = excluded.payroll_cost,
          source = excluded.source, external_id = excluded.external_id, updated_at = CURRENT_TIMESTAMP`)
        .bind(crypto.randomUUID(), workspace.id, company.id, metric.period, metric.headcount, metric.admissions, metric.terminations, metric.payrollCost, metric.externalId)
        .run();
      metricsSynced += 1;
    }
    await d1!.prepare("UPDATE fdp_integrations SET status = 'connected', last_sync_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(integration.id).run();
    await recordActivity(workspace.id, null, auth.user.email, "integration.synced", { channel, count: items.length, metricsSynced });
    return Response.json({ synced: items.length, metricsSynced, snapshot: await getWorkspaceSnapshot(auth.user) });
  } catch (error) {
    if (d1 && integrationId) {
      try {
        await d1.prepare("UPDATE fdp_integrations SET status = 'error', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(error instanceof Error ? error.message : "Falha ao sincronizar.", integrationId).run();
      } catch { /* Preserve the original integration error. */ }
    }
    return apiError(error);
  }
}
