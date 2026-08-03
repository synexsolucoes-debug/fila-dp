import { getD1 } from "@/db";
import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";
import { validateIntegrationEndpoint } from "@/lib/integration-security";

const supported = new Set(["email", "whatsapp", "teams", "drive", "onedrive", "erp"]);
const microsoftChannels = new Set(["teams", "onedrive"]);

type ExternalInboxItem = {
  senderName: string;
  subject: string;
  body: string;
  externalId: string;
};

type ExternalHrMetric = {
  companyId: string;
  period: string;
  headcount: number | null;
  headcountStart: number | null;
  headcountEnd: number | null;
  leavesCount: number | null;
  admissions: number | null;
  terminations: number | null;
  voluntaryTerminations: number | null;
  involuntaryTerminations: number | null;
  baseSalary: number | null;
  variablePay: number | null;
  overtimePay: number | null;
  additionalPay: number | null;
  vacationPay: number | null;
  thirteenthPay: number | null;
  terminationPay: number | null;
  grossPayroll: number | null;
  employeeInss: number | null;
  employeeIrrf: number | null;
  employeeOtherDeductions: number | null;
  netPay: number | null;
  employerInss: number | null;
  ratContribution: number | null;
  thirdPartyContributions: number | null;
  fgts: number | null;
  fgtsPenalty: number | null;
  employerCharges: number | null;
  benefitsCost: number | null;
  provisionsCost: number | null;
  otherCosts: number | null;
  payrollCost: number | null;
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
        externalId: text(item.id, 180),
      };
    }
    if (channel === "onedrive") {
      const parentReference = asRecord(item.parentReference);
      return {
        senderName: "Microsoft OneDrive",
        subject: text(item.name, 240) || "Arquivo do OneDrive",
        body: text(item.webUrl ?? parentReference.path, 5000),
        externalId: text(item.id ?? item.eTag, 180),
      };
    }
    return {
      senderName: text(item.senderName ?? item.from, 160) || "Integração",
      subject: text(item.subject ?? item.title, 240) || `Atualização via ${channel}`,
      body: text(item.body ?? item.text, 5000),
      externalId: text(item.externalId ?? item.messageId ?? item.id, 180),
    };
  }).filter((item) => item.subject || item.body);
}

function mapExternalMetrics(payload: Record<string, unknown>, fieldMap: Record<string, string> = {}): ExternalHrMetric[] {
  const responseBody = asRecord(payload.responseBody);
  const source = Array.isArray(payload.metrics) ? payload.metrics : Array.isArray(payload.records) ? payload.records : Array.isArray(responseBody.records) ? responseBody.records : [];
  return source.slice(0, 120).map((rawItem) => {
    const item = asRecord(rawItem);
    const numberValue = (value: unknown): number | null => {
      if (value === undefined || value === null || value === "") return null;
      const normalized = typeof value === "string" && value.includes(",") ? value.replace(/\./g, "").replace(",", ".") : value;
      const parsed = Number(normalized);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
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
      headcount: numberValue(valueFor("headcount", ["headcount", "colaboradores", "HEADCOUNT"])),
      headcountStart: numberValue(valueFor("headcountStart", ["headcountStart", "headcount_inicio", "QTDPESSOASINICIO"])),
      headcountEnd: numberValue(valueFor("headcountEnd", ["headcountEnd", "headcount_fim", "QTDPESSOASFIM"])),
      leavesCount: numberValue(valueFor("leavesCount", ["leavesCount", "afastados", "QTDAFASTADOS"])),
      admissions: numberValue(valueFor("admissions", ["admissions", "admissoes", "ADMISSOES"])),
      terminations: numberValue(valueFor("terminations", ["terminations", "rescisoes", "desligamentos", "DESLIGAMENTOS"])),
      voluntaryTerminations: numberValue(valueFor("voluntaryTerminations", ["voluntaryTerminations", "desligamentos_voluntarios", "DESLIGVOLUNTARIOS"])),
      involuntaryTerminations: numberValue(valueFor("involuntaryTerminations", ["involuntaryTerminations", "desligamentos_involuntarios", "DESLIGINVOLUNTARIOS"])),
      baseSalary: numberValue(valueFor("baseSalary", ["baseSalary", "salario_base", "VLRBASE"])),
      variablePay: numberValue(valueFor("variablePay", ["variablePay", "remuneracao_variavel", "VLRVARIAVEL"])),
      overtimePay: numberValue(valueFor("overtimePay", ["overtimePay", "horas_extras", "VLRHORAEXTRA"])),
      additionalPay: numberValue(valueFor("additionalPay", ["additionalPay", "adicionais", "VLRADICIONAIS"])),
      vacationPay: numberValue(valueFor("vacationPay", ["vacationPay", "ferias", "VLRFERIAS"])),
      thirteenthPay: numberValue(valueFor("thirteenthPay", ["thirteenthPay", "decimo_terceiro", "VLRDECIMOTERCEIRO"])),
      terminationPay: numberValue(valueFor("terminationPay", ["terminationPay", "verbas_rescisorias", "VLRRESCISAO"])),
      grossPayroll: numberValue(valueFor("grossPayroll", ["grossPayroll", "folha_bruta", "VLRFOLHABRUTA"])),
      employeeInss: numberValue(valueFor("employeeInss", ["employeeInss", "inss_colaborador", "VLRINSSEMPREGADO"])),
      employeeIrrf: numberValue(valueFor("employeeIrrf", ["employeeIrrf", "irrf", "VLRIRRF"])),
      employeeOtherDeductions: numberValue(valueFor("employeeOtherDeductions", ["employeeOtherDeductions", "outros_descontos", "VLROUTROSDESCONTOS"])),
      netPay: numberValue(valueFor("netPay", ["netPay", "folha_liquida", "VLRLIQUIDO"])),
      employerInss: numberValue(valueFor("employerInss", ["employerInss", "inss_patronal", "VLRINSSPATRONAL"])),
      ratContribution: numberValue(valueFor("ratContribution", ["ratContribution", "rat", "VLRRAT"])),
      thirdPartyContributions: numberValue(valueFor("thirdPartyContributions", ["thirdPartyContributions", "terceiros", "VLRTERCEIROS"])),
      fgts: numberValue(valueFor("fgts", ["fgts", "VLRFGTS"])),
      fgtsPenalty: numberValue(valueFor("fgtsPenalty", ["fgtsPenalty", "multa_fgts", "VLRMULTAFGTS"])),
      employerCharges: numberValue(valueFor("employerCharges", ["employerCharges", "encargos_patronais", "VLRENCARGOS"])),
      benefitsCost: numberValue(valueFor("benefitsCost", ["benefitsCost", "beneficios", "VLRBENEFICIOS"])),
      provisionsCost: numberValue(valueFor("provisionsCost", ["provisionsCost", "provisoes", "VLRPROVISOES"])),
      otherCosts: numberValue(valueFor("otherCosts", ["otherCosts", "outros_custos", "VLROUTROSCUSTOS"])),
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
    const configuredEndpoint = text(process.env[`FDP_${channel.toUpperCase()}_ENDPOINT`], 500);
    const endpointCandidate = text(config.endpoint, 500) || configuredEndpoint;
    const endpoint = endpointCandidate
      ? validateIntegrationEndpoint(
        channel,
        endpointCandidate,
        configuredEndpoint,
        [process.env.FDP_INTEGRATION_ALLOWED_HOSTS, process.env[`FDP_${channel.toUpperCase()}_ALLOWED_HOSTS`]].filter(Boolean).join(","),
      )
      : "";
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
      redirect: "error",
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
    let inboxSynced = 0;
    if (items.length) {
      const results = await d1!.batch(items.map((item) => {
        const taggedBody = item.externalId ? `${item.body}\n\n[external:${item.externalId}]` : item.body;
        return d1!.prepare(`INSERT INTO fdp_workspace_inbox_items
          (id, workspace_id, channel, sender_name, subject, body, external_id, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'new')
          ON CONFLICT (workspace_id, channel, external_id) DO NOTHING`)
          .bind(crypto.randomUUID(), workspace.id, channel, item.senderName, item.subject, taggedBody, item.externalId || null);
      }));
      inboxSynced = results.reduce((total, result) => total + Number(result.meta?.rows_written ?? result.meta?.changes ?? 0), 0);
    }
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
      const existing = await d1!.prepare(`SELECT * FROM fdp_hr_metrics
        WHERE workspace_id = ? AND company_id = ? AND period = ?`)
        .bind(workspace.id, company.id, metric.period)
        .first<Record<string, unknown>>();
      const incoming = metric as unknown as Record<string, number | null>;
      const value = (key: string, column: string) => incoming[key] === null || incoming[key] === undefined
        ? Number(existing?.[column] ?? 0)
        : Number(incoming[key]);
      const provided = (...keys: string[]) => keys.some((key) => incoming[key] !== null && incoming[key] !== undefined);
      const rawHeadcount = value("headcount", "headcount");
      const headcountStart = Math.round(incoming.headcountStart ?? incoming.headcount ?? Number(existing?.headcount_start ?? rawHeadcount));
      const headcountEnd = Math.round(incoming.headcountEnd ?? incoming.headcount ?? Number(existing?.headcount_end ?? rawHeadcount));
      const headcount = Math.round(incoming.headcount ?? ((headcountStart + headcountEnd) / 2));
      const leavesCount = Math.round(value("leavesCount", "leaves_count"));
      const admissions = Math.round(value("admissions", "admissions"));
      const voluntaryTerminations = Math.round(value("voluntaryTerminations", "voluntary_terminations"));
      const involuntaryTerminations = Math.round(value("involuntaryTerminations", "involuntary_terminations"));
      const terminations = Math.round(incoming.terminations ?? (provided("voluntaryTerminations", "involuntaryTerminations")
        ? voluntaryTerminations + involuntaryTerminations
        : Number(existing?.terminations ?? 0)));
      const baseSalary = value("baseSalary", "base_salary");
      const variablePay = value("variablePay", "variable_pay");
      const overtimePay = value("overtimePay", "overtime_pay");
      const additionalPay = value("additionalPay", "additional_pay");
      const vacationPay = value("vacationPay", "vacation_pay");
      const thirteenthPay = value("thirteenthPay", "thirteenth_pay");
      const terminationPay = value("terminationPay", "termination_pay");
      const calculatedGross = baseSalary + variablePay + overtimePay + additionalPay + vacationPay + thirteenthPay + terminationPay;
      const grossPayroll = incoming.grossPayroll ?? (provided("baseSalary", "variablePay", "overtimePay", "additionalPay", "vacationPay", "thirteenthPay", "terminationPay") ? calculatedGross : Number(existing?.gross_payroll ?? 0));
      const employeeInss = value("employeeInss", "employee_inss");
      const employeeIrrf = value("employeeIrrf", "employee_irrf");
      const employeeOtherDeductions = value("employeeOtherDeductions", "employee_other_deductions");
      const netPay = incoming.netPay ?? (provided("grossPayroll", "baseSalary", "variablePay", "overtimePay", "additionalPay", "vacationPay", "thirteenthPay", "terminationPay", "employeeInss", "employeeIrrf", "employeeOtherDeductions")
        ? Math.max(0, grossPayroll - employeeInss - employeeIrrf - employeeOtherDeductions)
        : Number(existing?.net_pay ?? 0));
      const employerInss = value("employerInss", "employer_inss");
      const ratContribution = value("ratContribution", "rat_contribution");
      const thirdPartyContributions = value("thirdPartyContributions", "third_party_contributions");
      const fgts = value("fgts", "fgts");
      const fgtsPenalty = value("fgtsPenalty", "fgts_penalty");
      const calculatedCharges = employerInss + ratContribution + thirdPartyContributions + fgts + fgtsPenalty;
      const employerCharges = incoming.employerCharges ?? (provided("employerInss", "ratContribution", "thirdPartyContributions", "fgts", "fgtsPenalty") ? calculatedCharges : Number(existing?.employer_charges ?? 0));
      const benefitsCost = value("benefitsCost", "benefits_cost");
      const provisionsCost = value("provisionsCost", "provisions_cost");
      const otherCosts = value("otherCosts", "other_costs");
      const calculatedTotal = grossPayroll + employerCharges + benefitsCost + provisionsCost + otherCosts;
      const payrollCost = incoming.payrollCost ?? (provided("grossPayroll", "baseSalary", "variablePay", "overtimePay", "additionalPay", "vacationPay", "thirteenthPay", "terminationPay", "employerCharges", "employerInss", "ratContribution", "thirdPartyContributions", "fgts", "fgtsPenalty", "benefitsCost", "provisionsCost", "otherCosts")
        ? calculatedTotal
        : Number(existing?.payroll_cost ?? 0));
      await d1!.prepare(`INSERT INTO fdp_hr_metrics
        (id, workspace_id, company_id, period, headcount, headcount_start, headcount_end, leaves_count, admissions, terminations,
          voluntary_terminations, involuntary_terminations, base_salary, variable_pay, overtime_pay, additional_pay, vacation_pay,
          thirteenth_pay, termination_pay, gross_payroll, employee_inss, employee_irrf, employee_other_deductions, net_pay,
          employer_inss, rat_contribution, third_party_contributions, fgts, fgts_penalty, employer_charges, benefits_cost,
          provisions_cost, other_costs, payroll_cost, source, external_id, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sankhya', ?, ?)
        ON CONFLICT(workspace_id, company_id, period) DO UPDATE SET headcount = excluded.headcount,
          headcount_start = excluded.headcount_start, headcount_end = excluded.headcount_end,
          leaves_count = excluded.leaves_count, admissions = excluded.admissions, terminations = excluded.terminations,
          voluntary_terminations = excluded.voluntary_terminations, involuntary_terminations = excluded.involuntary_terminations,
          base_salary = excluded.base_salary, variable_pay = excluded.variable_pay, overtime_pay = excluded.overtime_pay,
          additional_pay = excluded.additional_pay, vacation_pay = excluded.vacation_pay, thirteenth_pay = excluded.thirteenth_pay,
          termination_pay = excluded.termination_pay, gross_payroll = excluded.gross_payroll, employee_inss = excluded.employee_inss,
          employee_irrf = excluded.employee_irrf, employee_other_deductions = excluded.employee_other_deductions, net_pay = excluded.net_pay,
          employer_inss = excluded.employer_inss, rat_contribution = excluded.rat_contribution,
          third_party_contributions = excluded.third_party_contributions, fgts = excluded.fgts, fgts_penalty = excluded.fgts_penalty,
          employer_charges = excluded.employer_charges, benefits_cost = excluded.benefits_cost, provisions_cost = excluded.provisions_cost,
          other_costs = excluded.other_costs, payroll_cost = excluded.payroll_cost, source = excluded.source,
          external_id = excluded.external_id, notes = excluded.notes, updated_at = CURRENT_TIMESTAMP`)
        .bind(
          existing?.id ?? crypto.randomUUID(), workspace.id, company.id, metric.period, headcount, headcountStart, headcountEnd,
          leavesCount, admissions, terminations, voluntaryTerminations, involuntaryTerminations, baseSalary, variablePay,
          overtimePay, additionalPay, vacationPay, thirteenthPay, terminationPay, grossPayroll, employeeInss, employeeIrrf,
          employeeOtherDeductions, netPay, employerInss, ratContribution, thirdPartyContributions, fgts, fgtsPenalty,
          employerCharges, benefitsCost, provisionsCost, otherCosts, payrollCost, metric.externalId || String(existing?.external_id ?? ""),
          String(existing?.notes ?? ""),
        )
        .run();
      metricsSynced += 1;
    }
    await d1!.prepare("UPDATE fdp_integrations SET status = 'connected', last_sync_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(integration.id).run();
    await recordActivity(workspace.id, null, auth.user.email, "integration.synced", { channel, received: items.length, count: inboxSynced, metricsSynced });
    return Response.json({ received: items.length, synced: inboxSynced, metricsSynced, snapshot: await getWorkspaceSnapshot(auth.user) });
  } catch (error) {
    if (d1 && integrationId) {
      try {
        await d1.prepare("UPDATE fdp_integrations SET status = 'error', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(error instanceof Error ? error.message : "Falha ao sincronizar.", integrationId).run();
      } catch { /* Preserve the original integration error. */ }
    }
    return apiError(error);
  }
}
