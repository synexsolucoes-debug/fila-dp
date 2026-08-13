import type { getD1 } from "../../db/index.ts";
import { prepareAuditEvent } from "../fila-dp-db.ts";
import { prepareDomainEvent } from "../outbox.ts";
import { protectCpf } from "../registrations.ts";
import { normalizeSankhyaEmployee, normalizedEmployeeHash, persistedSankhyaEmployee } from "./normalization.ts";
import type { SankhyaRawData, VinculatoNormalizedEmployee } from "./types.ts";

type Database = ReturnType<typeof getD1>;
type Row = Record<string, unknown>;

function safeJson(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") { try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; } }
  return {};
}

function code(value: string, fallback: string) {
  return (value || fallback).normalize("NFD").replace(/[\u0300-\u036f]/gu, "").toUpperCase().replace(/[^A-Z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 80) || "SANKHYA";
}

async function upsertCatalog(d1: Database, input: { workspaceId: string; companyId: string; kind: "department" | "position" | "costCenter" | "schedule"; code: string; name: string }) {
  if (!input.name) return null;
  const catalogCode = code(input.code, input.name);
  const id = crypto.randomUUID();
  if (input.kind === "department") return d1.prepare(`INSERT INTO fdp_departments (id, workspace_id, company_id, code, name, status)
    VALUES (?, ?, ?, ?, ?, 'active') ON CONFLICT (workspace_id, company_id, code) DO UPDATE SET name = EXCLUDED.name, status = 'active', updated_at = CURRENT_TIMESTAMP RETURNING id`)
    .bind(id, input.workspaceId, input.companyId, catalogCode, input.name).first<{ id: string }>();
  if (input.kind === "position") return d1.prepare(`INSERT INTO fdp_positions (id, workspace_id, company_id, code, name, status)
    VALUES (?, ?, ?, ?, ?, 'active') ON CONFLICT (workspace_id, company_id, code) DO UPDATE SET name = EXCLUDED.name, status = 'active', updated_at = CURRENT_TIMESTAMP RETURNING id`)
    .bind(id, input.workspaceId, input.companyId, catalogCode, input.name).first<{ id: string }>();
  if (input.kind === "costCenter") return d1.prepare(`INSERT INTO fdp_cost_centers (id, workspace_id, company_id, code, name, status)
    VALUES (?, ?, ?, ?, ?, 'active') ON CONFLICT (workspace_id, company_id, code) DO UPDATE SET name = EXCLUDED.name, status = 'active', updated_at = CURRENT_TIMESTAMP RETURNING id`)
    .bind(id, input.workspaceId, input.companyId, catalogCode, input.name).first<{ id: string }>();
  return d1.prepare(`INSERT INTO fdp_work_schedules (id, workspace_id, company_id, code, name, weekly_hours, status)
    VALUES (?, ?, ?, ?, ?, 44, 'active') ON CONFLICT (workspace_id, company_id, code) DO UPDATE SET name = EXCLUDED.name, status = 'active', updated_at = CURRENT_TIMESTAMP RETURNING id`)
    .bind(id, input.workspaceId, input.companyId, catalogCode, input.name).first<{ id: string }>();
}

function changedFields(before: Record<string, unknown>, after: Record<string, unknown>) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null)).sort();
}

async function organizationalIds(d1: Database, workspaceId: string, companyId: string, employee: VinculatoNormalizedEmployee) {
  const [department, position, costCenter, schedule] = await Promise.all([
    upsertCatalog(d1, { workspaceId, companyId, kind: "department", code: employee.departmentCode, name: employee.departmentName }),
    upsertCatalog(d1, { workspaceId, companyId, kind: "position", code: employee.positionCode, name: employee.positionName || employee.functionName }),
    upsertCatalog(d1, { workspaceId, companyId, kind: "costCenter", code: employee.costCenterCode, name: employee.costCenterName }),
    upsertCatalog(d1, { workspaceId, companyId, kind: "schedule", code: employee.scheduleCode, name: employee.scheduleName }),
  ]);
  return { departmentId: department?.id ?? null, positionId: position?.id ?? null, costCenterId: costCenter?.id ?? null, workScheduleId: schedule?.id ?? null };
}

export async function importSankhyaEmployees(d1: Database, input: {
  workspaceId: string;
  integrationId: string;
  runId: string;
  companyId: string;
  records: SankhyaRawData[];
}) {
  const totals = { found: input.records.length, imported: 0, created: 0, updated: 0, unchanged: 0, ignored: 0, failed: 0 };
  for (let index = 0; index < input.records.length; index += 1) {
    const { normalized, errors } = normalizeSankhyaEmployee(input.records[index]);
    const itemId = crypto.randomUUID();
    const itemKey = `${String(index + 1).padStart(6, "0")}:${normalized.externalEmployeeId || "invalid"}`;
    if (errors.length) {
      totals.failed += 1;
      await d1.prepare(`INSERT INTO fdp_integration_sync_items
        (id, workspace_id, integration_id, run_id, item_key, external_id, status, payload_hash, target_type, metadata_json, error_code, error_message, processed_at)
        VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, 'employee', ?::jsonb, 'SANKHYA_RECORD_INVALID', 'Registro obrigatório ausente.', CURRENT_TIMESTAMP)`)
        .bind(itemId, input.workspaceId, input.integrationId, input.runId, itemKey, normalized.externalEmployeeId,
          normalizedEmployeeHash(normalized), JSON.stringify({ missingFields: errors })).run();
      continue;
    }

    const hash = normalizedEmployeeHash(normalized);
    const snapshot = persistedSankhyaEmployee(normalized);
    const cpf = protectCpf(normalized.cpfDigits);
    const reference = await d1.prepare(`SELECT ref.id, ref.employee_id, ref.normalized_hash, ref.normalized_json
      FROM fdp_employee_external_refs ref WHERE ref.workspace_id = ? AND ref.integration_id = ? AND ref.source = 'sankhya' AND ref.external_id = ?`)
      .bind(input.workspaceId, input.integrationId, normalized.externalEmployeeId).first<Row>();
    let employee = reference?.employee_id ? await d1.prepare(`SELECT id, registration_number, full_name, email, phone, admission_date, termination_date,
      employment_status, department_id, position_id, cost_center_id, work_schedule_id FROM fdp_employees WHERE workspace_id = ? AND id = ?`)
      .bind(input.workspaceId, reference.employee_id).first<Row>() : null;
    if (!employee) {
      employee = await d1.prepare("SELECT id, registration_number, full_name, email, phone, admission_date, termination_date, employment_status, department_id, position_id, cost_center_id, work_schedule_id FROM fdp_employees WHERE workspace_id = ? AND company_id = ? AND registration_number = ?")
        .bind(input.workspaceId, input.companyId, normalized.registrationNumber).first<Row>();
    }
    if (!employee && cpf.cpfHash) {
      employee = await d1.prepare("SELECT id, registration_number, full_name, email, phone, admission_date, termination_date, employment_status, department_id, position_id, cost_center_id, work_schedule_id FROM fdp_employees WHERE workspace_id = ? AND cpf_hash = ?")
        .bind(input.workspaceId, cpf.cpfHash).first<Row>();
    }

    const org = await organizationalIds(d1, input.workspaceId, input.companyId, normalized);
    const employeeId = employee ? String(employee.id) : crypto.randomUUID();
    const beforeSnapshot = reference ? safeJson(reference.normalized_json) : {};
    const fields = changedFields(beforeSnapshot, snapshot);
    const classification = !employee ? "new" : reference?.normalized_hash === hash ? "unchanged" : "changed";

    if (!employee) {
      await d1.prepare(`INSERT INTO fdp_employees (id, workspace_id, company_id, department_id, position_id, cost_center_id, work_schedule_id,
        registration_number, full_name, cpf_hash, cpf_last4, email, phone, admission_date, termination_date, employment_status,
        employment_type, work_model, source_system, external_id, notes, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::date, ?, 'clt', 'onsite', 'sankhya', ?, '', 'SYSTEM', 'SYSTEM')`)
        .bind(employeeId, input.workspaceId, input.companyId, org.departmentId, org.positionId, org.costCenterId, org.workScheduleId,
          normalized.registrationNumber, normalized.fullName, cpf.cpfHash, cpf.cpfLast4, normalized.email, normalized.phone,
          normalized.admissionDate, normalized.terminationDate || null, normalized.employmentStatus, normalized.externalEmployeeId).run();
      totals.created += 1;
      totals.imported += 1;
    } else if (classification === "changed") {
      await d1.prepare(`UPDATE fdp_employees SET department_id = ?, position_id = ?, cost_center_id = ?, work_schedule_id = ?,
        registration_number = ?, full_name = ?, cpf_hash = CASE WHEN ? = '' THEN cpf_hash ELSE ? END,
        cpf_last4 = CASE WHEN ? = '' THEN cpf_last4 ELSE ? END, email = ?, phone = ?, admission_date = ?::date,
        termination_date = ?::date, employment_status = ?, source_system = 'sankhya', external_id = ?, updated_by = 'SYSTEM', updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = ? AND id = ?`)
        .bind(org.departmentId, org.positionId, org.costCenterId, org.workScheduleId, normalized.registrationNumber, normalized.fullName,
          cpf.cpfHash, cpf.cpfHash, cpf.cpfLast4, cpf.cpfLast4, normalized.email, normalized.phone, normalized.admissionDate,
          normalized.terminationDate || null, normalized.employmentStatus, normalized.externalEmployeeId, input.workspaceId, employeeId).run();
      totals.updated += 1;
      totals.imported += 1;
    } else {
      totals.unchanged += 1;
      totals.ignored += 1;
    }

    const externalRefId = reference ? String(reference.id) : crypto.randomUUID();
    await d1.prepare(`INSERT INTO fdp_employee_external_refs
      (id, workspace_id, integration_id, employee_id, source, external_id, registration_number, normalized_hash, normalized_json, last_seen_at)
      VALUES (?, ?, ?, ?, 'sankhya', ?, ?, ?, ?::jsonb, CURRENT_TIMESTAMP)
      ON CONFLICT (workspace_id, integration_id, source, external_id) DO UPDATE SET employee_id = EXCLUDED.employee_id,
        registration_number = EXCLUDED.registration_number, normalized_hash = EXCLUDED.normalized_hash,
        normalized_json = EXCLUDED.normalized_json, last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`)
      .bind(externalRefId, input.workspaceId, input.integrationId, employeeId, normalized.externalEmployeeId, normalized.registrationNumber, hash, JSON.stringify(snapshot)).run();
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_employee_sync_changes
        (id, workspace_id, integration_id, run_id, external_ref_id, employee_id, classification, changed_fields_json, before_json, after_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb)`)
        .bind(crypto.randomUUID(), input.workspaceId, input.integrationId, input.runId, externalRefId, employeeId, classification,
          JSON.stringify(fields), JSON.stringify(beforeSnapshot), JSON.stringify(snapshot)),
      d1.prepare(`INSERT INTO fdp_integration_sync_items
        (id, workspace_id, integration_id, run_id, item_key, external_id, status, payload_hash, target_type, target_id, metadata_json, processed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'employee', ?, ?::jsonb, CURRENT_TIMESTAMP)`)
        .bind(itemId, input.workspaceId, input.integrationId, input.runId, itemKey, normalized.externalEmployeeId,
          classification === "unchanged" ? "skipped" : "processed", hash, employeeId, JSON.stringify({ classification, changedFields: fields })),
      prepareAuditEvent({ workspaceId: input.workspaceId, actorType: "integration", actorEmail: "SYSTEM", action: `sankhya.employee.${classification}`,
        entityType: "employee", entityId: employeeId, before: beforeSnapshot, after: snapshot, metadata: { integrationId: input.integrationId, runId: input.runId, changedFields: fields } }),
      ...(classification === "new" || classification === "changed" ? [prepareDomainEvent(d1, { workspaceId: input.workspaceId,
        eventType: classification === "new" ? "sankhya.employee.created" : "sankhya.employee.updated", entityType: "employee", entityId: employeeId,
        payload: { integrationId: input.integrationId, runId: input.runId, status: classification, occurredAt: new Date().toISOString() } })] : []),
    ]);
  }
  return totals;
}
