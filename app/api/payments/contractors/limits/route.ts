import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText, optionalDate } from "@/lib/registrations";
import { invoiceLimitScopes, positiveMoney, requiredPaymentEnum } from "@/lib/payments";

/**
 * Políticas de limite da nota fiscal.
 *
 * O limite não é constante de código: ele é configurado por workspace, empresa,
 * contrato ou prestador e resolvido na ordem prestador → contrato → empresa →
 * workspace. Cada alteração cria uma nova versão e encerra a vigência anterior,
 * preservando o histórico usado em competências já apuradas.
 */
export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "contractors.payments.read");
    const url = new URL(request.url);
    const includeHistory = url.searchParams.get("history") === "true";
    const rows = await d1.prepare(`SELECT p.id, p.scope, p.company_id, p.provider_id, p.contract_reference, p.amount, p.effective_from,
        p.effective_to, p.note, p.created_by, p.created_at, c.trade_name AS company_name, a.legal_name AS provider_name
      FROM fdp_invoice_limit_policies p
      LEFT JOIN fdp_companies c ON c.workspace_id = p.workspace_id AND c.id = p.company_id
      LEFT JOIN fdp_auxiliary_providers a ON a.workspace_id = p.workspace_id AND a.id = p.provider_id
      WHERE p.workspace_id = ? ${includeHistory ? "" : "AND (p.effective_to IS NULL OR p.effective_to >= CURRENT_DATE)"}
      ORDER BY p.scope, p.effective_from DESC`).bind(workspace.id).all<Record<string, unknown>>();
    return Response.json({ policies: rows.results, precedence: invoiceLimitScopes });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace.role, "contractors.limits.manage");

    const scope = requiredPaymentEnum(body.scope, invoiceLimitScopes, "Escopo do limite");
    const amount = positiveMoney(body.amount, "Limite da nota");
    const effectiveFrom = optionalDate(body.effectiveFrom, true) as string;
    const companyId = cleanText(body.companyId, 120) || null;
    const providerId = cleanText(body.providerId, 120) || null;
    const contractReference = cleanText(body.contractReference, 80);

    if ((scope === "company" || scope === "contract") && !companyId) throw ApiError.badRequest("Selecione a empresa da política.", "LIMIT_COMPANY_REQUIRED");
    if (scope === "contract" && !contractReference) throw ApiError.badRequest("Informe a referência do contrato.", "LIMIT_CONTRACT_REQUIRED");
    if (scope === "provider" && !providerId) throw ApiError.badRequest("Selecione o prestador da política.", "LIMIT_PROVIDER_REQUIRED");
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);

    const id = crypto.randomUUID();
    const previousDay = new Date(`${effectiveFrom}T12:00:00Z`);
    previousDay.setUTCDate(previousDay.getUTCDate() - 1);
    const closesAt = previousDay.toISOString().slice(0, 10);

    await d1.batch([
      // Encerra a vigência da política anterior do mesmo alvo sem apagar o histórico.
      d1.prepare(`UPDATE fdp_invoice_limit_policies SET effective_to = ?
        WHERE workspace_id = ? AND scope = ? AND company_id IS NOT DISTINCT FROM ? AND provider_id IS NOT DISTINCT FROM ?
          AND contract_reference = ? AND effective_to IS NULL AND effective_from <= ?`)
        .bind(closesAt, workspace.id, scope, companyId, providerId, contractReference, closesAt),
      d1.prepare(`INSERT INTO fdp_invoice_limit_policies (id, workspace_id, scope, company_id, provider_id, contract_reference, amount, effective_from, effective_to, note, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, workspace.id, scope, companyId, providerId, contractReference, amount, effectiveFrom, optionalDate(body.effectiveTo), cleanText(body.note, 300), user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "invoice_limit_policy.created", entityType: "invoice_limit_policy", entityId: id,
        after: { scope, companyId, providerId, contractReference, amount, effectiveFrom },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ policy: { id, scope, amount, effectiveFrom, companyId, providerId, contractReference } }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
