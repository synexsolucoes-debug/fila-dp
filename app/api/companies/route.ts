import { apiError, getApiUser, text } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceSnapshot, recordActivity, requireWorkspaceRole } from "@/lib/fila-dp-db";

export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    const result = await d1.prepare("SELECT id, legal_name, trade_name, tax_id, external_code, email, phone, status FROM fdp_companies WHERE workspace_id = ? ORDER BY legal_name").bind(workspace.id).all();
    return Response.json({ companies: result.results });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const legalName = text(body.legalName ?? body.name, 160);
    const taxId = text(body.taxId ?? body.cnpj, 30);
    if (!legalName) return Response.json({ error: "Informe a razão social da empresa." }, { status: 400 });
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireWorkspaceRole(workspace.role, ["admin", "member"]);
    if (taxId) {
      const existing = await d1.prepare("SELECT id FROM fdp_companies WHERE workspace_id = ? AND tax_id = ?").bind(workspace.id, taxId).first<{ id: string }>();
      if (existing) return Response.json({ error: "Já existe uma empresa com este CNPJ no workspace." }, { status: 409 });
    }
    const id = crypto.randomUUID();
    await d1.prepare(`INSERT INTO fdp_companies
      (id, workspace_id, legal_name, trade_name, tax_id, external_code, email, phone, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, workspace.id, legalName, text(body.tradeName, 160), taxId, text(body.externalCode, 80), text(body.email, 160), text(body.phone, 40), body.status === "inactive" ? "inactive" : "active")
      .run();
    await recordActivity(workspace.id, null, auth.user.email, "company.created", { companyId: id, legalName });
    return Response.json(await getWorkspaceSnapshot(auth.user), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
