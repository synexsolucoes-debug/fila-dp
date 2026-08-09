import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext } from "@/lib/fila-dp-db";
import { hasCapability } from "@/lib/authorization";
import { protectCpf } from "@/lib/registrations";

export const dynamic = "force-dynamic";

type SearchRecord = {
  kind: string;
  id: string;
  title: string;
  subtitle: string;
  badge: string;
  target: string;
};

/** CPF nunca volta em claro na busca: apenas os quatro últimos dígitos. */
function maskedCpf(last4: string) {
  return last4 ? `•••.•••.•${last4.slice(0, 1)}•-${last4.slice(1)}` : "";
}

/**
 * Resolve o termo para uma busca por CPF sem transportar o número:
 * onze dígitos viram HMAC e batem no hash gravado; quatro dígitos batem
 * nos últimos dígitos armazenados.
 */
function cpfLookup(term: string) {
  const digits = term.replace(/\D/gu, "");
  if (digits.length === 11) {
    try {
      const { cpfHash } = protectCpf(digits);
      return { hash: cpfHash, last4: "" };
    } catch {
      return { hash: "", last4: "" };
    }
  }
  if (digits.length === 4) return { hash: "", last4: digits };
  return { hash: "", last4: "" };
}

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, board, workspace, user } = await getWorkspaceContext(auth.user);
    const companyAccess = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
    const processType = (url.searchParams.get("processType") ?? "").trim().slice(0, 40);
    const slaStatus = (url.searchParams.get("slaStatus") ?? "").trim().slice(0, 20);
    const archived = url.searchParams.get("archived");

    const conditions = ["c.board_id = ?"];
    const values: unknown[] = [board.id];
    if (!companyAccess.unrestricted) {
      if (!companyAccess.companyIds.size) return Response.json({ results: [], records: [] });
      const companyIds = Array.from(companyAccess.companyIds);
      conditions.push(`c.company_id IN (${companyIds.map(() => "?").join(", ")})`);
      values.push(...companyIds);
    }
    if (q) {
      const term = `%${q}%`;
      conditions.push(`(c.title ILIKE ? OR c.description ILIKE ? OR c.company ILIKE ? OR c.assignee_name ILIKE ? OR c.process_type ILIKE ?
        OR EXISTS (SELECT 1 FROM fdp_custom_field_values cv WHERE cv.card_id = c.id AND cv.value_text ILIKE ?)
        OR EXISTS (SELECT 1 FROM fdp_card_assignees ca JOIN fdp_users u ON u.id = ca.user_id WHERE ca.card_id = c.id AND (u.name ILIKE ? OR u.email ILIKE ?))
        OR EXISTS (SELECT 1 FROM fdp_card_labels cl JOIN fdp_labels l ON l.id = cl.label_id WHERE cl.card_id = c.id AND l.name ILIKE ?))`);
      values.push(term, term, term, term, term, term, term, term, term);
    }
    if (processType) { conditions.push("c.process_type = ?"); values.push(processType); }
    if (slaStatus) { conditions.push("c.sla_status = ?"); values.push(slaStatus); }
    if (archived === "true" || archived === "false") { conditions.push("c.archived = ?"); values.push(archived === "true" ? 1 : 0); }

    const result = await d1.prepare(`SELECT c.id, c.title, c.company, c.process_type, c.priority, c.sla_status, c.due_at, c.assignee_name, c.archived, c.list_id
      FROM fdp_cards c WHERE ${conditions.join(" AND ")} ORDER BY c.archived, c.updated_at DESC LIMIT 50`).bind(...values).all<Record<string, unknown>>();

    const records = q ? await searchRecords(d1, workspace, companyAccess, q) : [];

    return Response.json({
      results: result.results.map((row) => ({
        id: String(row.id), title: String(row.title), company: String(row.company ?? ""), processType: String(row.process_type), priority: String(row.priority), slaStatus: String(row.sla_status), dueAt: row.due_at ? String(row.due_at) : null, assigneeName: String(row.assignee_name ?? ""), archived: Boolean(row.archived), listId: String(row.list_id),
      })),
      records,
    });
  } catch (error) {
    return apiError(error);
  }
}

/**
 * Busca global além das demandas: empresas, colaboradores (matrícula e CPF
 * mascarado), psicólogos, prestadores PJ, competências e integrações.
 * Cada domínio só entra quando o papel possui a capability correspondente.
 */
async function searchRecords(
  d1: Awaited<ReturnType<typeof getWorkspaceContext>>["d1"],
  workspace: Awaited<ReturnType<typeof getWorkspaceContext>>["workspace"],
  companyAccess: Awaited<ReturnType<typeof getCompanyAccessScope>>,
  q: string,
): Promise<SearchRecord[]> {
  const term = `%${q}%`;
  const companyIds = companyAccess.unrestricted ? null : [...companyAccess.companyIds];
  const companyFilter = (column: string) => (companyIds ? ` AND ${column} IN (${companyIds.map(() => "?").join(",")})` : "");
  const companyValues = companyIds ?? [];
  const records: SearchRecord[] = [];

  const tasks: Promise<SearchRecord[]>[] = [];

  if (hasCapability(workspace.role, "companies.read")) {
    tasks.push(d1.prepare(`SELECT id, legal_name, trade_name, tax_id, status FROM fdp_companies
      WHERE workspace_id = ? AND (legal_name ILIKE ? OR trade_name ILIKE ? OR tax_id ILIKE ?)${companyFilter("id")}
      ORDER BY trade_name LIMIT 8`)
      .bind(workspace.id, term, term, term, ...companyValues).all<Record<string, unknown>>()
      .then(({ results }) => results.map((row) => ({
        kind: "company",
        id: String(row.id),
        title: String(row.trade_name || row.legal_name),
        subtitle: String(row.legal_name),
        badge: String(row.status ?? ""),
        target: "registrations",
      }))));
  }

  if (hasCapability(workspace.role, "employees.read")) {
    const { hash, last4 } = cpfLookup(q);
    const cpfCondition = hash ? " OR e.cpf_hash = ?" : last4 ? " OR e.cpf_last4 = ?" : "";
    const cpfValue = hash ? [hash] : last4 ? [last4] : [];
    tasks.push(d1.prepare(`SELECT e.id, e.full_name, e.social_name, e.registration_number, e.cpf_last4, e.employment_status, c.trade_name AS company_name
      FROM fdp_employees e JOIN fdp_companies c ON c.workspace_id = e.workspace_id AND c.id = e.company_id
      WHERE e.workspace_id = ? AND (e.full_name ILIKE ? OR e.social_name ILIKE ? OR e.registration_number ILIKE ?${cpfCondition})${companyFilter("e.company_id")}
      ORDER BY e.full_name LIMIT 8`)
      .bind(workspace.id, term, term, term, ...cpfValue, ...companyValues).all<Record<string, unknown>>()
      .then(({ results }) => results.map((row) => ({
        kind: "employee",
        id: String(row.id),
        title: String(row.full_name),
        subtitle: [String(row.company_name ?? ""), `Matrícula ${row.registration_number}`, maskedCpf(String(row.cpf_last4 ?? ""))].filter(Boolean).join(" · "),
        badge: String(row.employment_status ?? ""),
        target: "registrations",
      }))));
  }

  if (hasCapability(workspace.role, "psychology.payments.read")) {
    tasks.push(d1.prepare(`SELECT id, code, legal_name, status FROM fdp_auxiliary_providers
      WHERE workspace_id = ? AND provider_type = 'psychologist' AND (legal_name ILIKE ? OR code ILIKE ?)
      ORDER BY legal_name LIMIT 5`)
      .bind(workspace.id, term, term).all<Record<string, unknown>>()
      .then(({ results }) => results.map((row) => ({
        kind: "psychologist",
        id: String(row.id),
        title: String(row.legal_name),
        subtitle: `Psicólogo · ${row.code}`,
        badge: String(row.status ?? ""),
        target: "psychologistPayments",
      }))));
  }

  if (hasCapability(workspace.role, "contractors.payments.read")) {
    tasks.push(d1.prepare(`SELECT a.id, a.code, a.legal_name, p.contract_reference, p.status
      FROM fdp_auxiliary_providers a JOIN fdp_contractor_profiles p ON p.workspace_id = a.workspace_id AND p.provider_id = a.id
      WHERE a.workspace_id = ? AND (a.legal_name ILIKE ? OR a.code ILIKE ? OR p.contract_reference ILIKE ?)${companyFilter("p.company_id")}
      ORDER BY a.legal_name LIMIT 5`)
      .bind(workspace.id, term, term, term, ...companyValues).all<Record<string, unknown>>()
      .then(({ results }) => results.map((row) => ({
        kind: "contractor",
        id: String(row.id),
        title: String(row.legal_name),
        subtitle: `Prestador PJ · ${row.contract_reference || row.code}`,
        badge: String(row.status ?? ""),
        target: "contractorPayments",
      }))));
  }

  if (hasCapability(workspace.role, "competences.read")) {
    tasks.push(d1.prepare(`SELECT k.id, k.competence, k.status, c.trade_name AS company_name FROM fdp_payroll_cycles k
      JOIN fdp_companies c ON c.workspace_id = k.workspace_id AND c.id = k.company_id
      WHERE k.workspace_id = ? AND k.competence ILIKE ?${companyFilter("k.company_id")}
      ORDER BY k.competence DESC LIMIT 5`)
      .bind(workspace.id, term, ...companyValues).all<Record<string, unknown>>()
      .then(({ results }) => results.map((row) => ({
        kind: "competence",
        id: String(row.id),
        title: `Competência ${row.competence}`,
        subtitle: String(row.company_name ?? ""),
        badge: String(row.status ?? ""),
        target: "processes",
      }))));
  }

  if (hasCapability(workspace.role, "integrations.status.read")) {
    tasks.push(d1.prepare(`SELECT id, channel, display_name, status FROM fdp_integrations
      WHERE workspace_id = ? AND (display_name ILIKE ? OR channel ILIKE ?)
      ORDER BY display_name LIMIT 5`)
      .bind(workspace.id, term, term).all<Record<string, unknown>>()
      .then(({ results }) => results.map((row) => ({
        kind: "integration",
        id: String(row.id),
        title: String(row.display_name || row.channel),
        subtitle: `Integração · ${row.channel}`,
        badge: String(row.status ?? ""),
        target: "integrations",
      }))));
  }

  for (const batch of await Promise.all(tasks)) records.push(...batch);
  return records.slice(0, 30);
}
