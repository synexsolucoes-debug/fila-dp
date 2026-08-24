import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText, protectCpf } from "@/lib/registrations";
import { readSankhyaEmployeeWorkbook } from "@/lib/sankhya-xlsx";

type Existing = Record<string, unknown>;

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const form = await request.formData();
    const file = form.get("file");
    const companyId = cleanText(form.get("companyId"), 120);
    const action = form.get("action") === "import" ? "import" : "preview";
    if (!(file instanceof File) || !companyId) throw ApiError.badRequest("Selecione a empresa e a planilha Sankhya.", "SANKHYA_IMPORT_REQUIRED");
    if (!file.name.toLowerCase().endsWith(".xlsx")) throw ApiError.badRequest("Envie uma planilha .xlsx.", "SANKHYA_IMPORT_TYPE");
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "employees.manage");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const records = await readSankhyaEmployeeWorkbook(await file.arrayBuffer());
    const existing = await d1.prepare(`SELECT id, company_id, registration_number, full_name, cpf_hash, cpf_last4, email, phone,
      birth_date, admission_date, termination_date, employment_status, external_id FROM fdp_employees WHERE workspace_id = ?`)
      .bind(workspace.id).all<Existing>();
    const byRegistration = new Map(existing.results.filter((row) => row.company_id === companyId).map((row) => [String(row.registration_number), row]));
    const byCpf = new Map(existing.results.filter((row) => row.cpf_hash).map((row) => [String(row.cpf_hash), row]));
    const byExternalId = new Map(existing.results.filter((row) => row.company_id === companyId && row.external_id).map((row) => [String(row.external_id), row]));
    const items = records.map((record) => {
      const cpf = protectCpf(record.cpf);
      const registrationMatch = byRegistration.get(record.registrationNumber);
      const cpfMatch = cpf.cpfHash ? byCpf.get(cpf.cpfHash) : undefined;
      const externalMatch = byExternalId.get(record.externalId);
      const candidateIds = new Set([registrationMatch, cpfMatch, externalMatch].filter(Boolean).map((row) => String(row?.id)));
      if (candidateIds.size > 1 || (registrationMatch?.cpf_hash && cpf.cpfHash && registrationMatch.cpf_hash !== cpf.cpfHash)) {
        return { record, cpf, match: registrationMatch ?? cpfMatch ?? externalMatch ?? null, classification: "conflict" as const };
      }
      const match = registrationMatch ?? cpfMatch ?? externalMatch;
      if (match && String(match.company_id) !== companyId) return { record, cpf, match, classification: "conflict" as const };
      if (!match) return { record, cpf, match: null, classification: "new" as const };
      const changed = String(match.registration_number) !== record.registrationNumber || String(match.full_name) !== record.fullName
        || String(match.email ?? "") !== record.email || String(match.phone ?? "") !== record.phone
        || String(match.admission_date).slice(0, 10) !== record.admissionDate
        || (record.birthDate && String(match.birth_date ?? "").slice(0, 10) !== record.birthDate)
        || String(match.termination_date ?? "").slice(0, 10) !== record.terminationDate
        || String(match.external_id ?? "") !== record.externalId
        || String(match.employment_status) !== (record.terminationDate ? "terminated" : "active");
      return { record, cpf, match, classification: changed ? "changed" as const : "unchanged" as const };
    });
    if (action === "preview") return Response.json({
      summary: Object.fromEntries(["new", "changed", "unchanged", "conflict"].map((key) => [key, items.filter((item) => item.classification === key).length])),
      items: items.slice(0, 500).map(({ record, classification }) => ({ externalId: record.externalId, registrationNumber: record.registrationNumber,
        fullName: record.fullName, cpfLast4: record.cpf.slice(-4), admissionDate: record.admissionDate, terminationDate: record.terminationDate, classification })),
    });

    const statements: D1PreparedStatement[] = [];
    let created = 0; let updated = 0; let unchanged = 0; let conflicts = 0;
    for (const item of items) {
      if (item.classification === "conflict") { conflicts += 1; continue; }
      if (item.classification === "unchanged") { unchanged += 1; continue; }
      const status = item.record.terminationDate ? "terminated" : "active";
      if (!item.match) {
        const id = crypto.randomUUID(); created += 1;
        statements.push(d1.prepare(`INSERT INTO fdp_employees (id, workspace_id, company_id, registration_number, full_name, cpf_hash,
          cpf_last4, email, phone, birth_date, admission_date, termination_date, employment_status, employment_type, work_model,
          source_system, external_id, notes, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::date, ?::date, ?::date,
          ?, 'clt', 'onsite', 'sankhya', ?, '', ?, ?)`)
          .bind(id, workspace.id, companyId, item.record.registrationNumber, item.record.fullName, item.cpf.cpfHash, item.cpf.cpfLast4,
            item.record.email, item.record.phone, item.record.birthDate || null, item.record.admissionDate, item.record.terminationDate || null,
            status, item.record.externalId, user.id, user.id));
      } else {
        updated += 1;
        statements.push(d1.prepare(`UPDATE fdp_employees SET registration_number = ?, full_name = ?, cpf_hash = CASE WHEN ? = '' THEN cpf_hash ELSE ? END,
          cpf_last4 = CASE WHEN ? = '' THEN cpf_last4 ELSE ? END, email = ?, phone = ?, birth_date = COALESCE(?::date, birth_date),
          admission_date = ?::date, termination_date = ?::date, employment_status = ?, source_system = 'sankhya', external_id = ?,
          updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?`)
          .bind(item.record.registrationNumber, item.record.fullName, item.cpf.cpfHash, item.cpf.cpfHash, item.cpf.cpfLast4, item.cpf.cpfLast4, item.record.email,
            item.record.phone, item.record.birthDate || null, item.record.admissionDate, item.record.terminationDate || null, status,
            item.record.externalId, user.id, workspace.id, String(item.match.id)));
      }
    }
    statements.push(prepareAuditEvent({ workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "employees.sankhya_imported", entityType: "employee_import", entityId: crypto.randomUUID(),
      after: { companyId, fileName: file.name, total: records.length, created, updated, unchanged, conflicts },
      requestId: request.headers.get("x-fila-dp-request-id") }));
    await d1.batch(statements);
    return Response.json({ created, updated, unchanged, conflicts });
  } catch (error) {
    return apiError(error instanceof Error && !(error instanceof ApiError) ? ApiError.badRequest(error.message, "SANKHYA_IMPORT_INVALID") : error);
  }
}
