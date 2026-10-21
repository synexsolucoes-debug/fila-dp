import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { payrollEmployee } from "@/lib/erp-payroll-service";
import { bankAccountFromRow, parseBankAccount } from "@/lib/payroll-settings-service";

type RouteContext = { params: Promise<{ id: string }> };

/** Conta de salário do colaborador (infotipo 0009 do SAP): para onde vai o crédito do CNAB. */
export async function GET(_request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "payroll.read");
    await payrollEmployee(d1, workspace.id, user.id, workspace.role, id);
    const row = await d1.prepare("SELECT * FROM fdp_employee_bank_accounts WHERE workspace_id = ? AND employee_id = ?").bind(workspace.id, id).first<Record<string, unknown>>();
    return Response.json({ account: row ? bankAccountFromRow(row) : null });
  } catch (error) { return apiError(error); }
}

export async function PUT(request: Request, context: RouteContext) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "payroll.manage");
    const employee = await payrollEmployee(d1, workspace.id, user.id, workspace.role, id);
    const account = parseBankAccount(body);
    const previous = await d1.prepare("SELECT * FROM fdp_employee_bank_accounts WHERE workspace_id = ? AND employee_id = ?").bind(workspace.id, id).first<Record<string, unknown>>();
    await d1.batch([
      d1.prepare(`INSERT INTO fdp_employee_bank_accounts (id, workspace_id, employee_id, bank_code, agency, agency_digit, account, account_digit, account_type, pix_key, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, employee_id) DO UPDATE SET bank_code = EXCLUDED.bank_code, agency = EXCLUDED.agency, agency_digit = EXCLUDED.agency_digit,
          account = EXCLUDED.account, account_digit = EXCLUDED.account_digit, account_type = EXCLUDED.account_type, pix_key = EXCLUDED.pix_key,
          updated_by = EXCLUDED.updated_by, updated_at = now()`)
        .bind(crypto.randomUUID(), workspace.id, id, account.bankCode, account.agency, account.agencyDigit, account.account, account.accountDigit,
          account.accountType, account.pixKey, user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "employee.bank_account.updated", entityType: "employee", entityId: id,
        before: previous ? bankAccountFromRow(previous) : null, after: account,
        metadata: { scope: "company", companyId: employee.companyId }, requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);
    return Response.json({ account });
  } catch (error) { return apiError(error); }
}
