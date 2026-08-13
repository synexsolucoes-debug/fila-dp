import { randomBytes } from "node:crypto";
import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { publicCredentialFingerprint, sealCredentials } from "@/lib/integrations";
import { log } from "@/lib/observability";

type Context = { params: Promise<{ id: string }> };

/**
 * Gera o segredo de assinatura do webhook **deste** workspace.
 *
 * Antes, o segredo vinha de uma variável de ambiente com o mapa de todos os
 * clientes: conectar um cliente novo exigia editar a variável e publicar de
 * novo, e girar o segredo de um mexia no arquivo de todos. Aqui ele nasce
 * aleatório, é selado no mesmo cofre AES das demais credenciais e fica
 * vinculado ao par (workspace, integração).
 *
 * O valor em claro é devolvido **uma única vez**, na resposta desta chamada, e
 * nunca mais: ele existe para ser colado no fluxo do Power Automate / na
 * configuração do provedor. Guardá-lo para reexibição depois transformaria a
 * tela de integrações num repositório de segredos em claro.
 */
export async function POST(request: Request, { params }: Context) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "workspace.integrations.manage");

    const integration = await d1.prepare("SELECT id, channel FROM fdp_integrations WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, id).first<{ id: string; channel: string }>();
    if (!integration) throw ApiError.notFound("Integração não encontrada.", "INTEGRATION_NOT_FOUND");
    if (!["email", "whatsapp", "teams"].includes(integration.channel)) {
      throw new ApiError(409, "WEBHOOK_NOT_SUPPORTED", "Este conector não recebe eventos por webhook.");
    }

    // 32 bytes de aleatoriedade criptográfica. O formato hexadecimal existe
    // para poder ser colado num cabeçalho HTTP sem escape.
    const secret = randomBytes(32).toString("hex");
    const sealed = sealCredentials(integration.channel, { token: secret });
    const credentialId = crypto.randomUUID();

    await d1.batch([
      // O segredo anterior é revogado na mesma transação: dois segredos ativos
      // significariam que girar o segredo não invalida o antigo.
      d1.prepare(`UPDATE fdp_integration_credentials
          SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, rotated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = ? AND integration_id = ? AND credential_type = 'webhook_signing' AND status = 'active'`)
        .bind(workspace.id, id),
      d1.prepare(`INSERT INTO fdp_integration_credentials
          (id, workspace_id, integration_id, credential_type, encrypted_value, initialization_vector, auth_tag, key_version, fingerprint, created_by)
        VALUES (?, ?, ?, 'webhook_signing', ?, ?, ?, ?, ?, ?)`)
        .bind(credentialId, workspace.id, id, sealed.encryptedValue, sealed.initializationVector, sealed.authTag, sealed.keyVersion, sealed.fingerprint, user.id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "integration.webhook_secret_rotated", entityType: "integration", entityId: id,
        // A trilha guarda a impressão digital, jamais o segredo.
        after: { credentialType: "webhook_signing", keyVersion: sealed.keyVersion, fingerprint: publicCredentialFingerprint(sealed.fingerprint), secretStored: true },
        requestId: request.headers.get("x-fila-dp-request-id"),
      }),
    ]);

    log("info", "integration.webhook_secret_rotated", { workspaceId: workspace.id, userId: user.id, connectorId: id }, {
      channel: integration.channel, keyVersion: sealed.keyVersion,
    });

    const base = process.env.FDP_PUBLIC_BASE_URL ?? new URL(request.url).origin;
    return Response.json({
      credentialId,
      // Única exibição do valor em claro.
      secret,
      webhookUrl: `${base}/api/integrations/webhook/${integration.channel}?workspaceId=${workspace.id}`,
      header: "x-fila-dp-secret",
      fingerprint: publicCredentialFingerprint(sealed.fingerprint),
      notice: "Copie o segredo agora: ele não será exibido novamente. Configure-o no cabeçalho x-fila-dp-secret do webhook.",
    }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
