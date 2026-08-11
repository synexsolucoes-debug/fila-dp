import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { hasCapability, requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { assertNoClinicalData, sanitizeProviderCode } from "@/lib/auxiliary";
import { cleanText } from "@/lib/registrations";
import { payoutSummary, positiveMoney, sanitizePayoutAccount, sealPayoutAccount, withoutSealedPayout } from "@/lib/payments";

/**
 * Cadastro do psicólogo: apenas dados administrativos e financeiros.
 * Nenhum campo clínico existe neste módulo — a finalidade é pagar consultas.
 */
export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "psychology.payments.read");
    const canManage = hasCapability(workspace, "psychology.payments.manage");
    const rows = await d1.prepare(`SELECT a.id, a.code, a.legal_name, a.trade_name, a.tax_id, a.email, a.phone, a.status AS provider_status,
        p.default_session_amount, p.administrative_notes, p.status, p.payout_encrypted, p.payout_key_version, p.updated_at
      FROM fdp_auxiliary_providers a
      LEFT JOIN fdp_psychologist_profiles p ON p.workspace_id = a.workspace_id AND p.provider_id = a.id
      WHERE a.workspace_id = ? AND a.provider_type = 'psychologist'
      ORDER BY a.status, a.legal_name`).bind(workspace.id).all<Record<string, unknown>>();
    return Response.json({
      psychologists: rows.results.map((row) => {
        const sealed = row.payout_encrypted;
        return {
          ...withoutSealedPayout(row),
          defaultSessionAmount: Number(row.default_session_amount ?? 0),
          configured: Boolean(row.default_session_amount !== null && row.default_session_amount !== undefined),
          payout: payoutSummary(sealed ? { encryptedValue: String(sealed), initializationVector: "", authTag: "", keyVersion: Number(row.payout_key_version ?? 0) } : null, null),
        };
      }),
      permissions: { manage: canManage, close: hasCapability(workspace, "psychology.payments.close") },
      privacyBoundary: "Módulo exclusivamente administrativo e financeiro: não armazena informação clínica.",
    });
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
    requireCapability(workspace, "psychology.payments.manage");

    const legalName = cleanText(body.legalName, 180);
    if (!legalName) throw ApiError.badRequest("Informe o nome do psicólogo.", "PSYCHOLOGIST_NAME_REQUIRED");
    const notes = cleanText(body.administrativeNotes, 500);
    assertNoClinicalData("psychology", legalName, notes, body.tradeName);

    const code = sanitizeProviderCode(body.code ?? legalName);
    const defaultSessionAmount = positiveMoney(body.defaultSessionAmount, "Valor padrão da consulta");
    const payout = sealPayoutAccount(body.payout);
    const providerId = crypto.randomUUID();

    const duplicate = await d1.prepare("SELECT id FROM fdp_auxiliary_providers WHERE workspace_id = ? AND code = ?").bind(workspace.id, code).first();
    if (duplicate) throw new ApiError(409, "PROVIDER_CODE_CONFLICT", "Já existe um fornecedor com este código.");

    await d1.batch([
      d1.prepare(`INSERT INTO fdp_auxiliary_providers (id, workspace_id, provider_type, code, legal_name, trade_name, tax_id, email, phone, status)
        VALUES (?, ?, 'psychologist', ?, ?, ?, ?, ?, ?, 'active')`)
        .bind(providerId, workspace.id, code, legalName, cleanText(body.tradeName, 180), cleanText(body.taxId, 20).replace(/\D/gu, ""),
          cleanText(body.email, 180).toLowerCase(), cleanText(body.phone, 40)),
      d1.prepare(`INSERT INTO fdp_psychologist_profiles (provider_id, workspace_id, default_session_amount, payout_encrypted, payout_iv, payout_tag, payout_key_version, administrative_notes, status, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
        .bind(providerId, workspace.id, defaultSessionAmount, payout?.encryptedValue ?? "", payout?.initializationVector ?? "",
          payout?.authTag ?? "", payout?.keyVersion ?? 0, notes, user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "psychologist.created", entityType: "psychologist", entityId: providerId,
        after: { code, legalName, defaultSessionAmount },
        metadata: { payoutConfigured: Boolean(payout), payoutFields: Object.keys(sanitizePayoutAccount(body.payout)) },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    return Response.json({ psychologist: { id: providerId, code, legalName, defaultSessionAmount } }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
