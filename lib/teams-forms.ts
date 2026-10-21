/**
 * Formulários do Teams (DP Operacional, Fases 3 e 4).
 *
 * O Teams continua sendo só origem: um fluxo do Power Automate publica o
 * formulário (Adaptive Card) no canal e posta a resposta aqui, com o mesmo
 * segredo do webhook do Teams que o grupo já configurou — o workspace vem do
 * segredo conferido, nunca de campo do corpo. O que volta na resposta é o que
 * o fluxo mostra no card: dentro ou fora do corte, e o aviso ao solicitante.
 */
import { getScopedD1 } from "../db/index.ts";
import { ApiError } from "./api-errors.ts";
import { assertWebhookSecret, parseTeamsConfig, resolveWebhookSecret } from "./teams-integration.ts";
import { setTenantContext } from "./tenant-context.ts";

export async function authenticateTeamsForm(request: Request) {
  const workspaceId = (new URL(request.url).searchParams.get("workspaceId") ?? "").trim().slice(0, 100);
  if (!workspaceId) throw ApiError.badRequest("workspaceId obrigatório.", "TEAMS_FORM_WORKSPACE_REQUIRED");
  setTenantContext({ workspaceId, userId: null });
  const d1 = getScopedD1({ workspaceId, userId: null });
  const integration = await d1.prepare("SELECT id, status, config_json FROM fdp_integrations WHERE workspace_id = ? AND channel = 'teams'")
    .bind(workspaceId).first<{ id: string; status: string; config_json: string }>();
  if (!integration) throw new ApiError(401, "WEBHOOK_UNAUTHORIZED", "Webhook não autorizado.");
  const expected = await resolveWebhookSecret(d1, workspaceId, integration.id, "teams");
  assertWebhookSecret(request.headers.get("x-fila-dp-secret") ?? request.headers.get("x-webhook-secret") ?? "", expected);
  if (integration.status === "paused") throw new ApiError(409, "INTEGRATION_PAUSED", "Integração pausada.");
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(integration.config_json || "{}") as Record<string, unknown>; } catch { config = {}; }
  return { d1, workspaceId, integrationId: integration.id, config: parseTeamsConfig(config) };
}

export const experienceDecisions = ["efetivar", "prorrogar", "desligar"] as const;
export type ExperienceDecision = typeof experienceDecisions[number];

export function parseExperienceDecision(value: unknown): ExperienceDecision | null {
  const text = String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/gu, "").trim().toLowerCase();
  if (text.startsWith("efetiv")) return "efetivar";
  if (text.startsWith("prorrog")) return "prorrogar";
  if (text.startsWith("deslig")) return "desligar";
  return null;
}
