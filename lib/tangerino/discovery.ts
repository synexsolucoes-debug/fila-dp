/**
 * A varredura que descobre admissões que o Vinculato ainda não conhece.
 *
 * As outras rotinas do agente partem de alguém que já está no Vinculato e vão
 * conferir a situação dele na origem. Esta faz o contrário, e é ela que fecha o
 * fluxo que o DP realmente usa: lê a lista de admissões abertas na Sólides,
 * registra cada uma e abre a demanda de quem já chegou a "Dados contratuais".
 *
 * ## Por que ler a lista, e não pesquisar
 *
 * Pesquisar exige um nome em mãos. O nome de quem está sendo admitido não está
 * em lugar nenhum do Vinculato — é exatamente a informação que falta. A lista,
 * por outro lado, já chega povoada: é a mesma tela que o DP abre todo dia.
 *
 * ## Limites, e por quê
 *
 * A leitura é somente leitura: abre cartão, lê situação e etapa, volta. Nada é
 * alterado na origem. O teto por execução existe pelo mesmo motivo da varredura
 * de conciliação — cada cartão aberto é uma navegação, e um lote sem limite
 * viraria uma enxurrada contra o sistema de outra empresa.
 */
import type { getD1 } from "../../db/index.ts";
import { openCredentials } from "../integrations.ts";
import { log } from "../observability.ts";
import { tangerinoAgentConfig } from "./config.ts";
import { tangerinoErrors } from "./errors.ts";
import { tangerinoBrowserLoginUrl } from "./hosts.ts";
import { ensureOpenAdmissionDemand, recordOpenAdmission } from "./open-admissions.ts";
import { isContractDataStage, isStableExternalAdmissionId, parseAdmission } from "./parser.ts";
import type { TangerinoSessionFactory } from "./types.ts";

type Database = ReturnType<typeof getD1>;

/** Cartões abertos por execução. O resto fica para o ciclo seguinte. */
export const DISCOVERY_BATCH_LIMIT = 15;

export type DiscoverySummary = {
  listed: number;
  recorded: number;
  demandsCreated: number;
  skipped: number;
};

type Credential = {
  encrypted_value: string;
  initialization_vector: string;
  auth_tag: string;
  key_version: number;
};

/**
 * Descobre e registra as admissões abertas de um grupo.
 *
 * Devolve `null` quando o grupo não tem integração configurada — não é falha,
 * é ausência de trabalho, e tratá-la como erro encheria o log de ruído em todo
 * grupo que não usa o agente.
 */
export async function discoverOpenAdmissions(
  d1: Database,
  workspaceId: string,
  createSession: TangerinoSessionFactory,
  options: { limit?: number } = {},
): Promise<DiscoverySummary | null> {
  const integration = await d1.prepare(`SELECT id FROM fdp_integrations
    WHERE workspace_id = ? AND channel = 'tangerino_browser'`)
    .bind(workspaceId).first<{ id: string }>();
  if (!integration) return null;
  const integrationId = String(integration.id);

  const credential = await d1.prepare(`SELECT encrypted_value, initialization_vector, auth_tag, key_version
    FROM fdp_integration_credentials
    WHERE workspace_id = ? AND integration_id = ? AND credential_type = 'provider_auth' AND status = 'active'
      AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP) ORDER BY created_at DESC LIMIT 1`)
    .bind(workspaceId, integrationId).first<Credential>();
  if (!credential) throw tangerinoErrors.credentialRequired();

  const secrets = openCredentials("tangerino_browser", {
    encryptedValue: credential.encrypted_value,
    initializationVector: credential.initialization_vector,
    authTag: credential.auth_tag,
    keyVersion: Number(credential.key_version),
  });
  if (!secrets.username || !secrets.password) throw tangerinoErrors.credentialRequired();

  const config = tangerinoAgentConfig();
  const limit = Math.max(1, Math.min(Number(options.limit) || DISCOVERY_BATCH_LIMIT, DISCOVERY_BATCH_LIMIT));
  const summary: DiscoverySummary = { listed: 0, recorded: 0, demandsCreated: 0, skipped: 0 };

  const session = await createSession({ workspaceId, integrationId });
  try {
    await session.ensureAuthenticated({
      endpoint: tangerinoBrowserLoginUrl,
      username: secrets.username,
      password: secrets.password,
      timeoutMs: config.timeoutMs,
    });
    await session.openAdmissions();
    const hits = await session.listAdmissions();
    summary.listed = hits.length;

    for (const hit of hits.slice(0, limit)) {
      await session.openAdmission(hit);
      const admission = parseAdmission(await session.readAdmission());
      await session.back();

      /* Um identificador como `card:0` vale para clicar nesta leitura e para
         mais nada: gravá-lo faria a execução seguinte tratar dois cartões
         diferentes como a mesma admissão. Sem identificador estável não há
         como garantir idempotência, e abrir demanda assim duplicaria trabalho
         do DP a cada ciclo. */
      const candidate = admission.externalAdmissionId || hit.id;
      if (!isStableExternalAdmissionId(candidate)) {
        summary.skipped += 1;
        log("warn", "tangerino.discovery_unstable_identifier", { workspaceId }, { stage: admission.stage });
        continue;
      }

      const record = await recordOpenAdmission(d1, {
        workspaceId,
        integrationId,
        externalAdmissionId: candidate,
        displayName: hit.label,
        admission,
      });
      if (!record) { summary.skipped += 1; continue; }
      summary.recorded += 1;

      if (!isContractDataStage(admission.stage) || record.cardId) continue;
      const demand = await ensureOpenAdmissionDemand(d1, {
        workspaceId,
        integrationId,
        openAdmissionId: record.id,
        externalAdmissionId: record.externalAdmissionId,
        displayName: record.displayName,
        admission,
      });
      if (demand.status === "created") summary.demandsCreated += 1;
    }
  } finally {
    await session.close().catch(() => undefined);
  }

  log("info", "tangerino.discovery_completed", { workspaceId }, summary);
  return summary;
}
