import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { companySettings, parseSettings } from "@/lib/payroll-settings-service";

/** Configuração de folha da empresa (§4.35): encargos, banco do CNAB e contas contábeis. */
export async function GET(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const companyId = new URL(request.url).searchParams.get("companyId") ?? "";
    if (!companyId) throw ApiError.badRequest("Escolha a empresa.", "SETTINGS_COMPANY_REQUIRED");
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "payroll.read");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    return Response.json({ settings: await companySettings(d1, workspace.id, companyId) });
  } catch (error) { return apiError(error); }
}

export async function PUT(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const companyId = String(body.companyId ?? "");
    if (!companyId) throw ApiError.badRequest("Escolha a empresa.", "SETTINGS_COMPANY_REQUIRED");
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "payroll.manage");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const settings = parseSettings(body);
    const before = await companySettings(d1, workspace.id, companyId);
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_company_payroll_settings (id, workspace_id, company_id, employer_contribution, rat_percent, fap, third_parties_percent,
          bank_code, bank_agency, bank_agency_digit, bank_account, bank_account_digit, bank_agreement, accounts_json, salary_floor_cents, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
        ON CONFLICT (workspace_id, company_id) DO UPDATE SET employer_contribution = EXCLUDED.employer_contribution, rat_percent = EXCLUDED.rat_percent,
          fap = EXCLUDED.fap, third_parties_percent = EXCLUDED.third_parties_percent, bank_code = EXCLUDED.bank_code, bank_agency = EXCLUDED.bank_agency,
          bank_agency_digit = EXCLUDED.bank_agency_digit, bank_account = EXCLUDED.bank_account, bank_account_digit = EXCLUDED.bank_account_digit,
          bank_agreement = EXCLUDED.bank_agreement, accounts_json = EXCLUDED.accounts_json,
          salary_floor_cents = EXCLUDED.salary_floor_cents, updated_by = EXCLUDED.updated_by, updated_at = now()`)
        .bind(crypto.randomUUID(), workspace.id, companyId, settings.employerContribution, settings.ratPercent, settings.fap, settings.thirdPartiesPercent,
          settings.bank?.code ?? "", settings.bank?.agency ?? "", settings.bank?.agencyDigit ?? "", settings.bank?.account ?? "",
          settings.bank?.accountDigit ?? "", settings.bank?.agreement ?? "", JSON.stringify(settings.accounts), settings.salaryFloorCents, user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "company.payroll_settings.updated", entityType: "company", entityId: companyId, before, after: settings,
        metadata: { scope: "company", companyId }, requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ settings });
  } catch (error) { return apiError(error); }
}
