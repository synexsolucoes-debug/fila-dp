import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { hasCapability, requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { epiDate } from "@/lib/epi-service";

/**
 * Relatórios do Controle de EPI.
 *
 * Treze relatórios, um contrato só: o mesmo recorte de empresa, os mesmos
 * filtros de período e as mesmas colunas em JSON e em CSV. O catálogo abaixo é
 * a definição única de cada um — a tela lê os títulos daqui, e não de uma
 * segunda lista que fosse divergir na primeira mudança.
 *
 * Exportar exige `epi.export` e fica registrado na auditoria com o relatório e
 * o recorte pedidos: quem levou dado de colaborador para fora do produto é
 * informação que precisa sobreviver ao download.
 */
type ReportDefinition = {
  title: string;
  description: string;
  /** `date` é a coluna de período, quando o relatório tem uma. */
  date: string | null;
  columns: Array<{ key: string; label: string }>;
  build: (alias: { where: string[]; values: unknown[] }) => { sql: string; values: unknown[] };
};

const companyColumns = [
  { key: "company_name", label: "Empresa" },
  { key: "company_tax_id", label: "CNPJ" },
];

const reports: Record<string, ReportDefinition> = {
  stock: {
    title: "Estoque de EPI",
    description: "Catálogo e saldo compartilhados pelo grupo, com valor unitário e validade do CA.",
    date: "p.registered_on",
    columns: [{ key: "epi_name", label: "EPI" }, { key: "ca_number", label: "CA" }, { key: "size", label: "Tamanho" },
      { key: "status", label: "Status" }, { key: "stock_quantity", label: "Em estoque" },
      { key: "unit_value", label: "Valor unitário" },
      { key: "ca_expires_on", label: "Validade do CA" }],
    build: ({ where, values }) => ({
      sql: `SELECT p.name AS epi_name, p.ca_number, p.size, p.status,
          COALESCE((SELECT SUM(b.quantity) FROM fdp_stock_balances b
            WHERE b.workspace_id = p.workspace_id AND b.product_id = p.id), 0) AS stock_quantity,
          p.unit_value, p.ca_expires_on
        FROM fdp_epi_products p
        WHERE ${where.join(" AND ")} ORDER BY p.name`,
      values,
    }),
  },
  deliveries: {
    title: "EPIs entregues",
    description: "Entregas do período, com colaborador, quantidade e estado do termo.",
    date: "d.delivered_on",
    columns: [...companyColumns,
      { key: "delivered_on", label: "Data" }, { key: "employee_name", label: "Colaborador" },
      { key: "registration_number", label: "Matrícula" }, { key: "epi_name", label: "EPI" },
      { key: "ca_number", label: "CA" }, { key: "size", label: "Tamanho" },
      { key: "quantity", label: "Quantidade" }, { key: "outstanding", label: "Em poder do colaborador" },
      { key: "unit_value", label: "Valor unitário" }, { key: "status", label: "Status" }],
    build: ({ where, values }) => ({
      sql: `SELECT COALESCE(NULLIF(c.trade_name, ''), c.legal_name) AS company_name, c.tax_id AS company_tax_id,
          d.delivered_on, COALESCE(NULLIF(e.social_name, ''), e.full_name) AS employee_name, e.registration_number,
          p.name AS epi_name, d.ca_number, d.size, d.quantity, (d.quantity - d.settled_quantity) AS outstanding,
          d.unit_value, d.status
        FROM fdp_epi_deliveries d
        JOIN fdp_epi_products p ON p.workspace_id = d.workspace_id AND p.id = d.product_id
        JOIN fdp_employees e ON e.workspace_id = d.workspace_id AND e.id = d.employee_id
        JOIN fdp_companies c ON c.workspace_id = d.workspace_id AND c.id = d.company_id
        WHERE ${where.join(" AND ")} ORDER BY d.delivered_on DESC, employee_name`,
      values,
    }),
  },
  by_employee: {
    title: "EPIs por colaborador",
    description: "O que cada colaborador tem em mãos hoje, somado por EPI.",
    date: "d.delivered_on",
    columns: [...companyColumns,
      { key: "employee_name", label: "Colaborador" }, { key: "registration_number", label: "Matrícula" },
      { key: "epi_name", label: "EPI" }, { key: "ca_number", label: "CA" }, { key: "size", label: "Tamanho" },
      { key: "outstanding", label: "Em poder" }, { key: "last_delivery", label: "Última entrega" },
      { key: "total_value", label: "Valor em poder" }],
    build: ({ where, values }) => ({
      sql: `SELECT COALESCE(NULLIF(c.trade_name, ''), c.legal_name) AS company_name, c.tax_id AS company_tax_id,
          COALESCE(NULLIF(e.social_name, ''), e.full_name) AS employee_name, e.registration_number,
          p.name AS epi_name, d.ca_number, d.size,
          SUM(d.quantity - d.settled_quantity) AS outstanding, MAX(d.delivered_on) AS last_delivery,
          SUM((d.quantity - d.settled_quantity) * d.unit_value) AS total_value
        FROM fdp_epi_deliveries d
        JOIN fdp_epi_products p ON p.workspace_id = d.workspace_id AND p.id = d.product_id
        JOIN fdp_employees e ON e.workspace_id = d.workspace_id AND e.id = d.employee_id
        JOIN fdp_companies c ON c.workspace_id = d.workspace_id AND c.id = d.company_id
        WHERE ${where.join(" AND ")} AND d.status <> 'canceled' AND d.quantity > d.settled_quantity
        GROUP BY company_name, c.tax_id, employee_name, e.registration_number, p.name, d.ca_number, d.size
        ORDER BY company_name, employee_name, p.name`,
      values,
    }),
  },
  by_company: {
    title: "Consumo de EPI por empresa/CNPJ",
    description: "Uso e ocorrências por empresa consumidora; o estoque permanece único no grupo.",
    date: null,
    columns: [...companyColumns,
      { key: "products_in_use", label: "Tipos em uso" }, { key: "outstanding", label: "Com colaboradores" },
      { key: "awaiting_disposal", label: "Aguardando descarte" },
      { key: "discounts_open", label: "Descontos em análise" }],
    build: ({ where, values }) => ({
      sql: `SELECT COALESCE(NULLIF(c.trade_name, ''), c.legal_name) AS company_name, c.tax_id AS company_tax_id,
          (SELECT COUNT(DISTINCT d.product_id) FROM fdp_epi_deliveries d
            WHERE d.workspace_id = c.workspace_id AND d.company_id = c.id
              AND d.status <> 'canceled' AND d.quantity > d.settled_quantity) AS products_in_use,
          (SELECT COALESCE(SUM(d.quantity - d.settled_quantity), 0) FROM fdp_epi_deliveries d
            WHERE d.workspace_id = c.workspace_id AND d.company_id = c.id AND d.status <> 'canceled') AS outstanding,
          (SELECT COUNT(*) FROM fdp_epi_disposals dp
            WHERE dp.workspace_id = c.workspace_id AND dp.company_id = c.id AND dp.status = 'awaiting_disposal') AS awaiting_disposal,
          (SELECT COUNT(*) FROM fdp_epi_discount_requests dr
            WHERE dr.workspace_id = c.workspace_id AND dr.company_id = c.id
              AND dr.status IN ('awaiting_dp_analysis', 'awaiting_approval')) AS discounts_open
        FROM fdp_companies c
        WHERE ${where.join(" AND ")}
        ORDER BY company_name`,
      values,
    }),
  },
  returns: {
    title: "EPIs devolvidos",
    description: "Devoluções do período, com a condição declarada e o destino dado ao equipamento.",
    date: "r.returned_on",
    columns: [...companyColumns,
      { key: "returned_on", label: "Data" }, { key: "employee_name", label: "Colaborador" },
      { key: "epi_name", label: "EPI" }, { key: "ca_number", label: "CA" }, { key: "size", label: "Tamanho" },
      { key: "quantity", label: "Quantidade" }, { key: "epi_condition", label: "Condição" },
      { key: "back_to_stock", label: "Voltou ao estoque" }, { key: "needs_sanitizing", label: "Higienização" },
      { key: "send_to_disposal", label: "Descarte" }, { key: "generate_dp_demand", label: "Gerou demanda DP" }],
    build: ({ where, values }) => ({
      sql: `SELECT COALESCE(NULLIF(c.trade_name, ''), c.legal_name) AS company_name, c.tax_id AS company_tax_id,
          r.returned_on, COALESCE(NULLIF(e.social_name, ''), e.full_name) AS employee_name, p.name AS epi_name,
          r.ca_number, r.size, r.quantity, r.epi_condition, r.back_to_stock, r.needs_sanitizing,
          r.send_to_disposal, r.generate_dp_demand
        FROM fdp_epi_returns r
        JOIN fdp_epi_products p ON p.workspace_id = r.workspace_id AND p.id = r.product_id
        JOIN fdp_employees e ON e.workspace_id = r.workspace_id AND e.id = r.employee_id
        JOIN fdp_companies c ON c.workspace_id = r.workspace_id AND c.id = r.company_id
        WHERE ${where.join(" AND ")} ORDER BY r.returned_on DESC`,
      values,
    }),
  },
  damages: {
    title: "EPIs danificados",
    description: "Ocorrências de dano, motivo apurado e decisão tomada na análise.",
    date: "dm.occurred_on",
    columns: [...companyColumns,
      { key: "occurred_on", label: "Data" }, { key: "employee_name", label: "Colaborador" },
      { key: "epi_name", label: "EPI" }, { key: "quantity", label: "Quantidade" },
      { key: "damage_reason", label: "Motivo" }, { key: "decision", label: "Decisão" },
      { key: "replacement_epi_name", label: "Novo EPI" }, { key: "description", label: "Descrição" }],
    build: ({ where, values }) => ({
      sql: `SELECT COALESCE(NULLIF(c.trade_name, ''), c.legal_name) AS company_name, c.tax_id AS company_tax_id,
          dm.occurred_on, COALESCE(NULLIF(e.social_name, ''), e.full_name) AS employee_name, p.name AS epi_name,
          dm.quantity, dm.damage_reason, dm.decision, rp.name AS replacement_epi_name, dm.description
        FROM fdp_epi_damages dm
        JOIN fdp_epi_products p ON p.workspace_id = dm.workspace_id AND p.id = dm.product_id
        LEFT JOIN fdp_epi_products rp ON rp.workspace_id = dm.workspace_id AND rp.id = dm.replacement_product_id
        JOIN fdp_employees e ON e.workspace_id = dm.workspace_id AND e.id = dm.employee_id
        JOIN fdp_companies c ON c.workspace_id = dm.workspace_id AND c.id = dm.company_id
        WHERE ${where.join(" AND ")} ORDER BY dm.occurred_on DESC`,
      values,
    }),
  },
  disposals: {
    title: "EPIs descartados",
    description: "Descartes abertos e confirmados, com responsável, motivo e data.",
    date: "dp.disposal_date",
    columns: [...companyColumns,
      { key: "disposal_date", label: "Data" }, { key: "epi_name", label: "EPI" },
      { key: "employee_name", label: "Colaborador" }, { key: "quantity", label: "Quantidade" },
      { key: "disposal_reason", label: "Motivo" }, { key: "status", label: "Status" },
      { key: "confirmed_at", label: "Confirmado em" }],
    build: ({ where, values }) => ({
      sql: `SELECT COALESCE(NULLIF(c.trade_name, ''), c.legal_name) AS company_name, c.tax_id AS company_tax_id,
          dp.disposal_date, p.name AS epi_name, COALESCE(NULLIF(e.social_name, ''), e.full_name) AS employee_name,
          dp.quantity, dp.disposal_reason, dp.status, dp.confirmed_at
        FROM fdp_epi_disposals dp
        JOIN fdp_epi_products p ON p.workspace_id = dp.workspace_id AND p.id = dp.product_id
        LEFT JOIN fdp_employees e ON e.workspace_id = dp.workspace_id AND e.id = dp.employee_id
        JOIN fdp_companies c ON c.workspace_id = dp.workspace_id AND c.id = dp.company_id
        WHERE ${where.join(" AND ")} ORDER BY dp.disposal_date DESC`,
      values,
    }),
  },
  sanitizing: {
    title: "EPIs pendentes de higienização",
    description: "Equipamentos devolvidos que ainda não voltaram ao estoque.",
    date: "r.returned_on",
    columns: [...companyColumns,
      { key: "returned_on", label: "Devolvido em" }, { key: "epi_name", label: "EPI" },
      { key: "employee_name", label: "Devolvido por" }, { key: "quantity", label: "Quantidade" },
      { key: "ca_number", label: "CA" }, { key: "size", label: "Tamanho" }],
    build: ({ where, values }) => ({
      sql: `SELECT COALESCE(NULLIF(c.trade_name, ''), c.legal_name) AS company_name, c.tax_id AS company_tax_id,
          r.returned_on, p.name AS epi_name, COALESCE(NULLIF(e.social_name, ''), e.full_name) AS employee_name,
          r.quantity, r.ca_number, r.size
        FROM fdp_epi_returns r
        JOIN fdp_epi_products p ON p.workspace_id = r.workspace_id AND p.id = r.product_id
        JOIN fdp_employees e ON e.workspace_id = r.workspace_id AND e.id = r.employee_id
        JOIN fdp_companies c ON c.workspace_id = r.workspace_id AND c.id = r.company_id
        WHERE ${where.join(" AND ")} AND r.needs_sanitizing = 1 AND p.status = 'sanitizing'
        ORDER BY r.returned_on`,
      values,
    }),
  },
  discounts: {
    title: "EPIs com possível desconto em análise",
    description: "Casos abertos para o DP, com o valor em análise e o parecer quando houver.",
    date: "dr.occurred_on",
    columns: [...companyColumns,
      { key: "occurred_on", label: "Ocorrência" }, { key: "employee_name", label: "Colaborador" },
      { key: "epi_name", label: "EPI" }, { key: "quantity", label: "Quantidade" },
      { key: "total_value", label: "Valor em análise" }, { key: "trigger_reason", label: "Motivo" },
      { key: "status", label: "Status" }, { key: "decision", label: "Decisão" },
      { key: "decided_value", label: "Valor decidido" }, { key: "demand_title", label: "Demanda" }],
    build: ({ where, values }) => ({
      sql: `SELECT COALESCE(NULLIF(c.trade_name, ''), c.legal_name) AS company_name, c.tax_id AS company_tax_id,
          dr.occurred_on, COALESCE(NULLIF(e.social_name, ''), e.full_name) AS employee_name, p.name AS epi_name,
          dr.quantity, dr.total_value, dr.trigger_reason, dr.status, dr.decision, dr.decided_value,
          card.title AS demand_title
        FROM fdp_epi_discount_requests dr
        JOIN fdp_epi_products p ON p.workspace_id = dr.workspace_id AND p.id = dr.product_id
        JOIN fdp_employees e ON e.workspace_id = dr.workspace_id AND e.id = dr.employee_id
        JOIN fdp_companies c ON c.workspace_id = dr.workspace_id AND c.id = dr.company_id
        LEFT JOIN fdp_cards card ON card.workspace_id = dr.workspace_id AND card.id = dr.card_id
        WHERE ${where.join(" AND ")} ORDER BY dr.occurred_on DESC`,
      values,
    }),
  },
  unsigned: {
    title: "EPIs sem termo de entrega assinado",
    description: "Entregas registradas cujo termo continua pendente de assinatura.",
    date: "d.delivered_on",
    columns: [...companyColumns,
      { key: "delivered_on", label: "Entregue em" }, { key: "employee_name", label: "Colaborador" },
      { key: "epi_name", label: "EPI" }, { key: "quantity", label: "Quantidade" },
      { key: "days_pending", label: "Dias pendente" }, { key: "attachments_count", label: "Anexos" }],
    build: ({ where, values }) => ({
      sql: `SELECT COALESCE(NULLIF(c.trade_name, ''), c.legal_name) AS company_name, c.tax_id AS company_tax_id,
          d.delivered_on, COALESCE(NULLIF(e.social_name, ''), e.full_name) AS employee_name, p.name AS epi_name,
          d.quantity, (CURRENT_DATE - d.delivered_on) AS days_pending,
          (SELECT COUNT(*) FROM fdp_epi_attachments a WHERE a.workspace_id = d.workspace_id
            AND a.entity_type = 'delivery' AND a.entity_id = d.id) AS attachments_count
        FROM fdp_epi_deliveries d
        JOIN fdp_epi_products p ON p.workspace_id = d.workspace_id AND p.id = d.product_id
        JOIN fdp_employees e ON e.workspace_id = d.workspace_id AND e.id = d.employee_id
        JOIN fdp_companies c ON c.workspace_id = d.workspace_id AND c.id = d.company_id
        WHERE ${where.join(" AND ")} AND d.status IN ('delivered', 'pending_signature')
        ORDER BY d.delivered_on`,
      values,
    }),
  },
  by_ca: {
    title: "EPIs por CA",
    description: "Agrupamento por Certificado de Aprovação, com validade e saldo.",
    date: "p.registered_on",
    columns: [{ key: "ca_number", label: "CA" }, { key: "epi_name", label: "EPI" },
      { key: "items", label: "Cadastros" }, { key: "stock", label: "Em estoque" },
      { key: "ca_expires_on", label: "Validade do CA" }],
    build: ({ where, values }) => ({
      sql: `SELECT p.ca_number, p.name AS epi_name, COUNT(*) AS items,
          COALESCE(SUM(p.stock_quantity), 0) AS stock, MIN(p.ca_expires_on) AS ca_expires_on
        FROM fdp_epi_products p
        WHERE ${where.join(" AND ")}
        GROUP BY p.workspace_id, p.ca_number, p.name ORDER BY p.ca_number`,
      values,
    }),
  },
  movements: {
    title: "Movimentações de EPI por competência",
    description: "O razão completo do período, na competência de cada movimentação.",
    date: "m.movement_date",
    columns: [{ key: "competence", label: "Competência" }, ...companyColumns,
      { key: "movement_date", label: "Data" }, { key: "movement_type", label: "Tipo" },
      { key: "epi_name", label: "EPI" }, { key: "employee_name", label: "Colaborador" },
      { key: "quantity", label: "Quantidade" }, { key: "stock_delta", label: "Efeito no estoque" },
      { key: "movement_reason", label: "Motivo" }, { key: "status", label: "Status" }],
    build: ({ where, values }) => ({
      sql: `SELECT to_char(m.movement_date, 'YYYY-MM') AS competence,
          COALESCE(COALESCE(NULLIF(c.trade_name, ''), c.legal_name), 'Grupo inteiro') AS company_name,
          COALESCE(c.tax_id, '') AS company_tax_id,
          m.movement_date, m.movement_type, m.epi_name, m.employee_name, m.quantity, m.stock_delta,
          m.movement_reason, m.status
        FROM fdp_epi_movements m
        LEFT JOIN fdp_companies c ON c.workspace_id = m.workspace_id AND c.id = m.company_id
        WHERE ${where.join(" AND ")} ORDER BY m.movement_date DESC, m.created_at DESC`,
      values,
    }),
  },
  employee_history: {
    title: "Histórico de EPI por colaborador",
    description: "Toda movimentação registrada para cada colaborador, na ordem em que aconteceu.",
    date: "m.movement_date",
    columns: [...companyColumns,
      { key: "employee_name", label: "Colaborador" }, { key: "movement_date", label: "Data" },
      { key: "movement_type", label: "Movimentação" }, { key: "epi_name", label: "EPI" },
      { key: "ca_number", label: "CA" }, { key: "size", label: "Tamanho" },
      { key: "quantity", label: "Quantidade" }, { key: "epi_condition", label: "Condição" },
      { key: "status", label: "Status" }, { key: "notes", label: "Observação" }],
    build: ({ where, values }) => ({
      sql: `SELECT COALESCE(NULLIF(c.trade_name, ''), c.legal_name) AS company_name, c.tax_id AS company_tax_id,
          m.employee_name, m.movement_date, m.movement_type, m.epi_name, m.ca_number, m.size, m.quantity,
          m.epi_condition, m.status, m.notes
        FROM fdp_epi_movements m
        JOIN fdp_companies c ON c.workspace_id = m.workspace_id AND c.id = m.company_id
        WHERE ${where.join(" AND ")} AND m.employee_id IS NOT NULL
        ORDER BY m.employee_name, m.movement_date DESC`,
      values,
    }),
  },
};

/** Prefixo da tabela de cada relatório, para o recorte de empresa acertar o alvo. */
const scopeAlias: Record<string, string> = {
  stock: "p", deliveries: "d", by_employee: "d", by_company: "c", returns: "r", damages: "dm",
  disposals: "dp", sanitizing: "r", discounts: "dr", unsigned: "d", by_ca: "p",
  movements: "m", employee_history: "m",
};

const groupScopedReports = new Set(["stock", "by_ca"]);
const nullableCompanyReports = new Set(["movements"]);

export const epiReportCatalog = Object.entries(reports).map(([key, definition]) => ({
  key, title: definition.title, description: definition.description, columns: definition.columns,
}));

function csvCell(value: unknown) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  // O apóstrofo à frente neutraliza fórmula em planilha: um campo livre que
  // comece com `=` vira código executável ao abrir o arquivo.
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replaceAll('"', '""')}"`;
}

export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "epi.view", "abrir os relatórios de EPI");
    const url = new URL(request.url);
    const key = cleanText(url.searchParams.get("report"), 60);
    if (!key) return Response.json({ reports: epiReportCatalog });
    const definition = reports[key];
    if (!definition) throw ApiError.notFound("Relatório não encontrado.", "EPI_REPORT_NOT_FOUND");

    const format = cleanText(url.searchParams.get("format"), 10) || "json";
    if (format === "csv") requireNamedCapability(workspace, "epi.export", "exportar relatórios de EPI");

    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    if (!access.unrestricted && access.companyIds.size === 0
      && !groupScopedReports.has(key) && !nullableCompanyReports.has(key)) {
      return format === "csv"
        ? new Response("", { headers: { "Content-Type": "text/csv; charset=utf-8" } })
        : Response.json({ report: key, title: definition.title, columns: definition.columns, rows: [] });
    }

    const alias = scopeAlias[key];
    const where = [`${alias}.workspace_id = ?`]; const values: unknown[] = [workspace.id];
    if (!groupScopedReports.has(key) && !access.unrestricted) {
      const ids = [...access.companyIds];
      if (nullableCompanyReports.has(key)) {
        where.push(ids.length ? `(${alias}.company_id IS NULL OR ${alias}.company_id IN (${ids.map(() => "?").join(",")}))` : `${alias}.company_id IS NULL`);
        values.push(...ids);
      } else {
        where.push(`${alias}.company_id IN (${ids.map(() => "?").join(",")})`); values.push(...ids);
      }
    }
    if (companyId && !groupScopedReports.has(key)) {
      where.push(nullableCompanyReports.has(key) ? `(${alias}.company_id IS NULL OR ${alias}.company_id = ?)` : `${alias}.company_id = ?`);
      values.push(companyId);
    }
    const employeeId = cleanText(url.searchParams.get("employeeId"), 120);
    if (employeeId && ["by_employee", "deliveries", "returns", "damages", "disposals", "discounts", "unsigned", "employee_history"].includes(key)) {
      where.push(`${alias === "m" ? "m.employee_id" : `${alias}.employee_id`} = ?`); values.push(employeeId);
    }
    if (definition.date) {
      const from = epiDate(url.searchParams.get("from"), "a data inicial", false);
      if (from) { where.push(`${definition.date} >= ?`); values.push(from); }
      const to = epiDate(url.searchParams.get("to"), "a data final", false);
      if (to) { where.push(`${definition.date} <= ?`); values.push(to); }
    }
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 500, 1), 5000);
    const query = definition.build({ where, values });
    const result = await d1.prepare(`${query.sql} LIMIT ?`).bind(...query.values, limit).all<Record<string, unknown>>();

    if (format === "csv") {
      const header = definition.columns.map((column) => csvCell(column.label)).join(";");
      const lines = result.results.map((row) => definition.columns.map((column) => csvCell(row[column.key])).join(";"));
      await prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email, action: "epi_report.exported",
        entityType: "epi_report", entityId: key,
        metadata: { report: key, companyId: companyId || "all", rows: result.results.length, employeeId: employeeId || null },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }).run();
      // BOM para o Excel em português abrir o arquivo em UTF-8 sem estragar os
      // acentos — sem ele "Danificação" chega como "DanificaÃ§Ã£o".
      return new Response(`﻿${[header, ...lines].join("\r\n")}\r\n`, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="epi-${key}-${new Date().toISOString().slice(0, 10)}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }

    return Response.json({
      report: key, title: definition.title, description: definition.description,
      columns: definition.columns, rows: result.results,
      canExport: hasCapability(workspace, "epi.export"),
    });
  } catch (error) { return apiError(error); }
}
