import { createHmac } from "node:crypto";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";
import { EMPLOYEE_WORKBOOK_FILENAME, EMPLOYEE_WORKBOOK_SOURCE, parseEmployeeWorkbook, type EmployeeWorkbookRecord } from "@/lib/employee-workbook-source";

const MAX_WORKBOOK_BYTES = 10 * 1024 * 1024;

type CompanyRow = { id: string; legal_name: string; trade_name: string; tax_id: string; external_code: string; is_principal: number };
type PersonRow = { id: string; full_name: string; email: string };
type EmploymentRow = { id: string; person_id: string; company_id: string; regime: string; source: string; external_id: string };

function normalizedText(value: unknown) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Z0-9]+/gi, " ").replace(/\s+/g, " ").trim().toUpperCase();
}

function digits(value: unknown) {
  return String(value ?? "").replace(/\D/g, "");
}

function formattedCnpj(value: string) {
  const raw = digits(value);
  return raw.length === 14 ? raw.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : "";
}

function companyDisplayName(record: EmployeeWorkbookRecord) {
  const label = record.companyLabel || record.registrationUnit || "Empresa da planilha";
  return record.registrationUnit && normalizedText(record.registrationUnit) !== normalizedText(label) ? `${label} - ${record.registrationUnit}` : label;
}

function sourceKey(identity: string) {
  const secret = process.env.FDP_AUTH_SECRET ?? "";
  if (secret.length < 24) throw new Error("FDP_AUTH_SECRET precisa estar configurado para importar a planilha com segurança.");
  return createHmac("sha256", secret).update(`${EMPLOYEE_WORKBOOK_SOURCE}:${identity}`).digest("hex");
}

async function runInChunks(d1: D1Database, statements: D1PreparedStatement[], size = 80) {
  for (let index = 0; index < statements.length; index += size) await d1.batch(statements.slice(index, index + size));
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin"]);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "Selecione a planilha Funcionários GRUPO OPYT.xlsx." }, { status: 400 });
    if (!/\.xlsx$/i.test(file.name) || file.size <= 0 || file.size > MAX_WORKBOOK_BYTES) {
      return Response.json({ error: "Envie um arquivo XLSX válido com até 10 MB." }, { status: 400 });
    }
    const records = parseEmployeeWorkbook(await file.arrayBuffer());
    const createCompanies = form.get("createCompanies") !== "false";
    const period = /^\d{4}-\d{2}$/.test(String(form.get("period") ?? "")) ? String(form.get("period")) : new Date().toISOString().slice(0, 7);

    const companyResult = await d1.prepare("SELECT id, legal_name, trade_name, tax_id, external_code, is_principal FROM fdp_companies WHERE workspace_id = ? ORDER BY is_principal DESC, legal_name").bind(workspace.id).all<CompanyRow>();
    const companies = [...companyResult.results];
    const principalCompanyId = companies.find((company) => Boolean(company.is_principal))?.id ?? null;
    const companiesByTax = new Map(companies.filter((company) => digits(company.tax_id).length === 14).map((company) => [digits(company.tax_id), company]));
    const companiesByExternalCode = new Map(companies.filter((company) => company.external_code).map((company) => [company.external_code, company]));
    const createdCompanyIds = new Set<string>();

    const resolveCompany = async (record: EmployeeWorkbookRecord) => {
      const taxId = digits(record.companyTaxId);
      if (taxId && companiesByTax.has(taxId)) return companiesByTax.get(taxId)!;
      const label = normalizedText(record.companyLabel);
      const unit = normalizedText(record.registrationUnit);
      const byName = companies.find((company) => {
        const legal = normalizedText(company.legal_name);
        const trade = normalizedText(company.trade_name);
        return Boolean(label && (legal === label || trade === label || (label.length >= 4 && (legal.includes(label) || trade.includes(label)))))
          || Boolean(unit && (legal === unit || trade === unit));
      });
      if (byName && !taxId) return byName;
      const externalCode = taxId ? `xlsx:${taxId}` : `xlsx:name:${normalizedText(record.companyLabel || record.registrationUnit).replace(/\s+/g, "-").toLowerCase()}`;
      const byExternalCode = companiesByExternalCode.get(externalCode);
      if (byExternalCode) return byExternalCode;
      if (!createCompanies || (!label && !unit)) return null;
      const id = crypto.randomUUID();
      const name = companyDisplayName(record);
      await d1.prepare(`INSERT INTO fdp_companies (id, workspace_id, parent_company_id, is_principal, legal_name, trade_name, tax_id, external_code, status)
        VALUES (?, ?, ?, 0, ?, ?, ?, ?, 'active')`)
        .bind(id, workspace.id, principalCompanyId, name, record.companyLabel || record.registrationUnit, formattedCnpj(taxId), externalCode).run();
      const company: CompanyRow = { id, legal_name: name, trade_name: record.companyLabel || record.registrationUnit, tax_id: formattedCnpj(taxId), external_code: externalCode, is_principal: 0 };
      companies.push(company);
      if (taxId) companiesByTax.set(taxId, company);
      companiesByExternalCode.set(externalCode, company);
      createdCompanyIds.add(id);
      return company;
    };

    const resolved: Array<{ record: EmployeeWorkbookRecord; companyId: string; externalId: string }> = [];
    let skipped = 0;
    for (const record of records) {
      const company = await resolveCompany(record);
      if (!company) { skipped += 1; continue; }
      resolved.push({ record, companyId: company.id, externalId: sourceKey(record.sourceIdentity) });
    }

    const [peopleResult, employmentResult, policiesResult] = await Promise.all([
      d1.prepare("SELECT id, full_name, email FROM fdp_people WHERE workspace_id = ?").bind(workspace.id).all<PersonRow>(),
      d1.prepare("SELECT id, person_id, company_id, regime, source, external_id FROM fdp_employments WHERE workspace_id = ?").bind(workspace.id).all<EmploymentRow>(),
      d1.prepare("SELECT id, company_id, name, benefit_type FROM fdp_benefit_policies WHERE workspace_id = ? AND active = 1").bind(workspace.id).all<{ id: string; company_id: string; name: string; benefit_type: string }>(),
    ]);
    const peopleByEmail = new Map(peopleResult.results.filter((person) => person.email).map((person) => [person.email.trim().toLowerCase(), person]));
    const peopleByName = new Map(peopleResult.results.map((person) => [normalizedText(person.full_name), person]));
    const employmentsBySource = new Map(employmentResult.results.filter((employment) => employment.source === EMPLOYEE_WORKBOOK_SOURCE && employment.external_id).map((employment) => [employment.external_id, employment]));
    const employmentsByNaturalKey = new Map(employmentResult.results.map((employment) => [`${employment.person_id}:${employment.company_id}:${employment.regime}`, employment]));
    const policyByCompanyType = new Map(policiesResult.results.map((policy) => [`${policy.company_id}:${policy.benefit_type}`, policy.id]));

    const companyBenefitTypes = new Set(resolved.flatMap(({ record, companyId }) => [record.mealBenefit > 0 ? `${companyId}:meal` : "", record.transportBenefit > 0 ? `${companyId}:transport` : ""].filter(Boolean)));
    const policyStatements: D1PreparedStatement[] = [];
    for (const key of companyBenefitTypes) {
      if (policyByCompanyType.has(key)) continue;
      const [companyId, benefitType] = key.split(":");
      const id = crypto.randomUUID();
      const name = benefitType === "meal" ? "Vale-alimentação — fonte Grupo OPYT" : "Vale-transporte — fonte Grupo OPYT";
      policyByCompanyType.set(key, id);
      policyStatements.push(d1.prepare(`INSERT INTO fdp_benefit_policies
        (id, workspace_id, company_id, name, benefit_type, eligible_regime, monthly_value, employee_discount, channel, active)
        VALUES (?, ?, ?, ?, ?, 'all', 0, 0, 'payroll', 1)`).bind(id, workspace.id, companyId, name, benefitType));
    }
    await runInChunks(d1, policyStatements);

    const employmentStatements: D1PreparedStatement[] = [];
    const employmentIds = new Map<string, string>();
    let created = 0;
    let updated = 0;
    for (const item of resolved) {
      const { record, companyId, externalId } = item;
      let person = (record.email ? peopleByEmail.get(record.email) : undefined) ?? peopleByName.get(normalizedText(record.fullName));
      if (!person) {
        person = { id: crypto.randomUUID(), full_name: record.fullName, email: record.email };
        peopleByName.set(normalizedText(record.fullName), person);
        if (record.email) peopleByEmail.set(record.email, person);
        employmentStatements.push(d1.prepare("INSERT INTO fdp_people (id, workspace_id, full_name, preferred_name, email, phone, status) VALUES (?, ?, ?, '', ?, '', 'active')")
          .bind(person.id, workspace.id, record.fullName, record.email));
      } else {
        employmentStatements.push(d1.prepare(`UPDATE fdp_people SET full_name = ?, email = CASE WHEN ? <> '' THEN ? ELSE email END, status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND workspace_id = ?`)
          .bind(record.fullName, record.email, record.email, person.id, workspace.id));
      }
      const naturalKey = `${person.id}:${companyId}:${record.regime}`;
      const existing = employmentsBySource.get(externalId) ?? employmentsByNaturalKey.get(naturalKey);
      if (existing) {
        employmentIds.set(externalId, existing.id);
        updated += 1;
        employmentStatements.push(d1.prepare(`UPDATE fdp_employments SET person_id = ?, company_id = ?, regime = ?, job_title = ?, department = ?, cost_center = ?,
          start_date = COALESCE(?, start_date), monthly_value = ?, status = 'active', source = ?, external_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND workspace_id = ?`)
          .bind(person.id, companyId, record.regime, record.jobTitle, record.department, record.costCenter, record.startDate, record.monthlyValue, EMPLOYEE_WORKBOOK_SOURCE, externalId, existing.id, workspace.id));
      } else {
        const employmentId = crypto.randomUUID();
        employmentIds.set(externalId, employmentId);
        created += 1;
        employmentStatements.push(d1.prepare(`INSERT INTO fdp_employments
          (id, workspace_id, person_id, company_id, employee_code, regime, job_title, department, cost_center, manager_name, start_date, monthly_value, status, source, external_id)
          VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, '', ?, ?, 'active', ?, ?)`)
          .bind(employmentId, workspace.id, person.id, companyId, record.regime, record.jobTitle, record.department, record.costCenter, record.startDate, record.monthlyValue, EMPLOYEE_WORKBOOK_SOURCE, externalId));
      }
    }
    await runInChunks(d1, employmentStatements);

    const benefitStatements: D1PreparedStatement[] = [];
    let benefitMovements = 0;
    for (const item of resolved) {
      const employmentId = employmentIds.get(item.externalId);
      if (!employmentId) continue;
      for (const [benefitType, amount] of [["meal", item.record.mealBenefit], ["transport", item.record.transportBenefit]] as const) {
        if (!(amount > 0)) continue;
        const policyId = policyByCompanyType.get(`${item.companyId}:${benefitType}`);
        if (!policyId) continue;
        benefitMovements += 1;
        benefitStatements.push(d1.prepare(`INSERT INTO fdp_benefit_movements
          (id, workspace_id, policy_id, employment_id, company_id, period, amount, employee_discount, status, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'calculated', ?)
          ON CONFLICT(employment_id, policy_id, period) DO UPDATE SET amount = excluded.amount, status = excluded.status,
            notes = excluded.notes, updated_at = CURRENT_TIMESTAMP`)
          .bind(crypto.randomUUID(), workspace.id, policyId, employmentId, item.companyId, period, amount, `Importado de ${EMPLOYEE_WORKBOOK_FILENAME}, linha ${item.record.sourceRow}.`));
      }
    }
    await runInChunks(d1, benefitStatements);

    const warningCount = records.reduce((total, record) => total + record.warnings.length, 0);
    await recordActivity(workspace.id, null, auth.user.email, "employment.workbook_synced", {
      source: EMPLOYEE_WORKBOOK_FILENAME,
      sheet: "GRUPO OPYT",
      rows: records.length,
      created,
      updated,
      skipped,
      companiesCreated: createdCompanyIds.size,
      benefitMovements,
      warningCount,
    });
    const snapshot = await getWorkspaceSnapshot(auth.user);
    return Response.json({
      ...snapshot,
      operationMessage: `Planilha sincronizada: ${created} vínculo(s) criado(s), ${updated} atualizado(s), ${benefitMovements} benefício(s) lançado(s) e ${skipped} ignorado(s).`,
      importSummary: { source: EMPLOYEE_WORKBOOK_FILENAME, rows: records.length, created, updated, skipped, companiesCreated: createdCompanyIds.size, benefitMovements, warningCount, period },
    });
  } catch (error) {
    return apiError(error);
  }
}
