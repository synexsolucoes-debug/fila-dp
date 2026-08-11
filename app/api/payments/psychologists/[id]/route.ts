import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { assertNoClinicalData } from "@/lib/auxiliary";
import { cleanText } from "@/lib/registrations";
import { openPayoutAccount, payoutSummary, positiveMoney, sanitizePayoutAccount, sealPayoutAccount, withoutSealedPayout } from "@/lib/payments";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "psychology.payments.manage");
    const row = await d1.prepare(`SELECT a.id, a.code, a.legal_name, a.trade_name, a.tax_id, a.email, a.phone,
        p.default_session_amount, p.administrative_notes, p.status, p.payout_encrypted, p.payout_iv, p.payout_tag, p.payout_key_version
      FROM fdp_auxiliary_providers a
      LEFT JOIN fdp_psychologist_profiles p ON p.workspace_id = a.workspace_id AND p.provider_id = a.id
      WHERE a.workspace_id = ? AND a.id = ? AND a.provider_type = 'psychologist'`)
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (!row) throw ApiError.notFound("Psicólogo não encontrado.", "PSYCHOLOGIST_NOT_FOUND");
    const sealedValue = String(row.payout_encrypted ?? "");
    const sealed = sealedValue
      ? { encryptedValue: sealedValue, initializationVector: String(row.payout_iv), authTag: String(row.payout_tag), keyVersion: Number(row.payout_key_version) }
      : null;
    return Response.json({
      psychologist: { ...withoutSealedPayout(row), payout: payoutSummary(sealed, sealed ? openPayoutAccount(sealed) : null) },
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "psychology.payments.manage");

    const current = await d1.prepare(`SELECT a.id, a.legal_name, a.status AS provider_status, p.default_session_amount, p.status
      FROM fdp_auxiliary_providers a
      LEFT JOIN fdp_psychologist_profiles p ON p.workspace_id = a.workspace_id AND p.provider_id = a.id
      WHERE a.workspace_id = ? AND a.id = ? AND a.provider_type = 'psychologist'`)
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (!current) throw ApiError.notFound("Psicólogo não encontrado.", "PSYCHOLOGIST_NOT_FOUND");

    const legalName = cleanText(body.legalName, 180) || String(current.legal_name);
    const notes = cleanText(body.administrativeNotes, 500);
    assertNoClinicalData("psychology", legalName, notes, body.tradeName);
    const defaultSessionAmount = positiveMoney(body.defaultSessionAmount ?? current.default_session_amount ?? 0, "Valor padrão da consulta");
    const status = body.status === "inactive" ? "inactive" : "active";
    const payout = Object.hasOwn(body, "payout") ? sealPayoutAccount(body.payout) : null;

    const statements = [
      d1.prepare(`UPDATE fdp_auxiliary_providers SET legal_name = ?, trade_name = ?, email = ?, phone = ?, status = ?, updated_at = now()
        WHERE workspace_id = ? AND id = ?`)
        .bind(legalName, cleanText(body.tradeName, 180), cleanText(body.email, 180).toLowerCase(), cleanText(body.phone, 40), status, workspace.id, id),
      d1.prepare(`INSERT INTO fdp_psychologist_profiles (provider_id, workspace_id, default_session_amount, administrative_notes, status, updated_by)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (provider_id) DO UPDATE SET default_session_amount = EXCLUDED.default_session_amount,
          administrative_notes = EXCLUDED.administrative_notes, status = EXCLUDED.status, updated_by = EXCLUDED.updated_by, updated_at = now()`)
        .bind(id, workspace.id, defaultSessionAmount, notes, status, user.id),
    ];
    if (payout) {
      statements.push(d1.prepare(`UPDATE fdp_psychologist_profiles SET payout_encrypted = ?, payout_iv = ?, payout_tag = ?, payout_key_version = ?, updated_at = now()
        WHERE workspace_id = ? AND provider_id = ?`)
        .bind(payout.encryptedValue, payout.initializationVector, payout.authTag, payout.keyVersion, workspace.id, id));
    }
    statements.push(prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "psychologist.updated", entityType: "psychologist", entityId: id,
      before: { legalName: current.legal_name, defaultSessionAmount: Number(current.default_session_amount ?? 0), status: current.status },
      after: { legalName, defaultSessionAmount, status },
      metadata: { payoutRotated: Boolean(payout), payoutFields: Object.keys(sanitizePayoutAccount(body.payout)) },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }));

    await d1.batch(statements);
    return Response.json({ psychologist: { id, legalName, defaultSessionAmount, status } });
  } catch (error) {
    return apiError(error);
  }
}
