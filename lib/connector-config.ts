import type { getD1 } from "../db";
import { ApiError } from "./api-errors.ts";
import { validateConnectorEndpoint } from "./integrations.ts";
import { solidesDateToIso } from "./solides.ts";

type Database = ReturnType<typeof getD1>;

/* Mesma semântica do `text` de `fila-dp-api`, copiada de propósito: aquele
   módulo alcança `@/app` e arrastá-lo para cá tornaria este arquivo impossível
   de exercitar fora do Next. É a regra que `tangerino/hosts.ts` já registra
   neste repositório — quem precisa do dado não deve herdar as dependências de
   quem o usa. Oito caracteres duplicados custam menos que um módulo de regras
   que só o servidor inteiro consegue carregar. */
const text = (value: unknown, max = 5000) =>
  (typeof value === "string" ? value.trim().slice(0, max) : "");

/**
 * As regras de configuração de um conector — uma cartilha só, para as duas
 * portas que gravam (§1).
 *
 * Até aqui estas funções moravam dentro de `app/api/integrations/[id]/route.ts`,
 * e por isso a configuração só existia no console do workspace. O console da
 * plataforma passou a precisar das mesmas regras, e havia duas saídas: copiar
 * ou compartilhar. Copiar é o caminho que produz o defeito silencioso — as duas
 * cópias divergem, e a que fica para trás grava um `config_json` que a outra
 * recusaria. Um endpoint fora da allowlist aceito por uma das portas não é um
 * detalhe de forma: é o conector apontando para um host que ninguém autorizou.
 *
 * Então o módulo é a autoridade e as rotas são só as portas. O que muda entre
 * elas é **quem** pode abrir e **o que fica registrado** — nunca o que é aceito.
 *
 * ## O que este módulo deliberadamente não faz
 *
 * Não toca em segredo. Credencial entra por outro caminho, cifrada, e
 * `assertNoSecrets` existe justamente para recusar quando alguém tenta
 * empurrar senha por aqui — inclusive aninhada dentro do corpo livre.
 */

const sensitiveKey = /token|password|secret|senha|chave|authorization|cookie|api.?key/iu;

/** Canal cuja configuração não passa por aqui: ele tem porta própria na plataforma. */
export const PLATFORM_ONLY_CHANNEL = "sankhya_browser";

/** Os campos que cada canal aceita — é isto que a tela usa para montar o formulário. */
export type ConnectorField = {
  key: string;
  label: string;
  hint: string;
  kind: "text" | "url" | "date" | "number" | "toggles";
  options?: readonly string[];
};

const ENDPOINT_FIELD: ConnectorField = {
  key: "endpoint", label: "Endpoint", kind: "url",
  hint: "Endereço oficial do conector. Hosts fora da lista permitida são recusados pelo servidor.",
};

const ADMISSION_FIELDS: readonly ConnectorField[] = [
  { key: "accountReference", label: "Referência da conta", kind: "text",
    hint: "Identificador do cliente na origem. Não é segredo e aparece nos registros." },
  { key: "admissionsSince", label: "Admissões a partir de", kind: "date",
    hint: "Data de corte das conciliações de admissão, no formato AAAA-MM-DD." },
  { key: "boardId", label: "Quadro de destino", kind: "text",
    hint: "Onde as demandas geradas por este conector nascem." },
  { key: "companyId", label: "Empresa de destino", kind: "text",
    hint: "Empresa do workspace a que os registros importados pertencem." },
  { key: "pageSize", label: "Tamanho da página", kind: "number",
    hint: "Quantos registros por requisição à origem. Máximo 150." },
];

const TEAMS_FIELDS: readonly ConnectorField[] = [
  { key: "tenantId", label: "Tenant", kind: "text", hint: "Identificador do tenant Microsoft." },
  { key: "teamId", label: "Equipe", kind: "text", hint: "Identificador da equipe que recebe os avisos." },
  { key: "teamName", label: "Nome da equipe", kind: "text", hint: "Como a equipe aparece nos registros." },
  { key: "channelId", label: "Canal", kind: "text", hint: "Identificador do canal de destino." },
  { key: "channelName", label: "Nome do canal", kind: "text", hint: "Como o canal aparece nos registros." },
  { key: "boardId", label: "Quadro de destino", kind: "text", hint: "Onde as demandas geradas nascem." },
  { key: "companyId", label: "Empresa de destino", kind: "text", hint: "Empresa a que os avisos pertencem." },
  { key: "automations", label: "Avisos automáticos", kind: "toggles",
    hint: "Quais eventos disparam aviso. Desmarcar silencia o evento; não desliga a integração.",
    options: ["admission", "termination", "warning", "role_change", "salary_change"] },
];

export const AUTOMATION_KEYS = ["admission", "termination", "warning", "role_change", "salary_change"] as const;

export const AUTOMATION_LABELS: Record<string, string> = {
  admission: "Admissão", termination: "Desligamento", warning: "Advertência",
  role_change: "Mudança de cargo", salary_change: "Mudança salarial",
};

/**
 * O formulário que um canal aceita.
 *
 * A tela pergunta ao servidor em vez de manter a própria lista: uma lista na
 * tela envelhece sozinha, e o sintoma é um campo que a pessoa preenche e o
 * servidor descarta em silêncio, sem erro nenhum.
 */
export function connectorFields(channel: string): readonly ConnectorField[] {
  if (channel === PLATFORM_ONLY_CHANNEL) return [];
  if (channel === "teams") return [ENDPOINT_FIELD, ...TEAMS_FIELDS];
  if (channel === "solides" || channel === "tangerino") return [ENDPOINT_FIELD, ...ADMISSION_FIELDS];
  return [ENDPOINT_FIELD];
}

function hasSensitiveConfig(value: unknown, depth = 0): boolean {
  if (depth > 5) return true;
  if (Array.isArray(value)) return value.some((item) => hasSensitiveConfig(item, depth + 1));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>)
    .some(([key, item]) => sensitiveKey.test(key) || hasSensitiveConfig(item, depth + 1));
}

export function safeRequestBody(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw ApiError.badRequest("O corpo configurado deve ser um objeto JSON.", "INTEGRATION_REQUEST_BODY_INVALID");
  }
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw, "utf8") > 16 * 1024 || hasSensitiveConfig(value)) {
    throw ApiError.badRequest("A configuração contém campos secretos ou excede 16 KB.", "INTEGRATION_CONFIG_UNSAFE");
  }
  return value as Record<string, unknown>;
}

/** Destino e recorte das conciliações vindas da Sólides (Gestão ou DP). Nenhum destes campos é segredo. */
function admissionSyncConfig(body: Record<string, unknown>) {
  const admissionsSince = solidesDateToIso(body.admissionsSince);
  if (text(body.admissionsSince, 40) && !admissionsSince) {
    throw ApiError.badRequest("Informe a data de corte das admissões no formato AAAA-MM-DD.", "SOLIDES_ADMISSIONS_SINCE_INVALID");
  }
  const pageSize = Math.trunc(Number(body.pageSize) || 0);
  return {
    ...(admissionsSince ? { admissionsSince } : {}),
    ...(text(body.boardId, 80) ? { boardId: text(body.boardId, 80) } : {}),
    ...(text(body.companyId, 80) ? { companyId: text(body.companyId, 80) } : {}),
    ...(pageSize > 0 ? { pageSize: Math.min(150, pageSize) } : {}),
  };
}

function teamsConfig(body: Record<string, unknown>) {
  const automation = body.automations && typeof body.automations === "object" && !Array.isArray(body.automations)
    ? body.automations as Record<string, unknown> : {};
  return {
    ...(text(body.tenantId, 100) ? { tenantId: text(body.tenantId, 100) } : {}),
    ...(text(body.teamId, 200) ? { teamId: text(body.teamId, 200) } : {}),
    ...(text(body.teamName, 160) ? { teamName: text(body.teamName, 160) } : {}),
    ...(text(body.channelId, 200) ? { channelId: text(body.channelId, 200) } : {}),
    ...(text(body.channelName, 160) ? { channelName: text(body.channelName, 160) } : {}),
    ...(text(body.boardId, 80) ? { boardId: text(body.boardId, 80) } : {}),
    ...(text(body.companyId, 80) ? { companyId: text(body.companyId, 80) } : {}),
    automations: Object.fromEntries(AUTOMATION_KEYS.map((key) => [key, automation[key] !== false])),
  };
}

export type ConnectorConfigResult = {
  displayName: string;
  status: "paused" | "needs_credentials";
  config: Record<string, unknown>;
  configuredFields: string[];
};

/**
 * Monta e valida o `config_json` de um conector a partir do que a tela enviou.
 *
 * Devolve também o `status`, porque ele é consequência da gravação e não uma
 * escolha independente: mexer na configuração invalida o que já foi conectado,
 * e deixar o conector em `connected` depois de trocar o endpoint faria a tela
 * afirmar uma conexão que ninguém provou existir contra o endereço novo.
 */
export function buildConnectorConfig(input: {
  channel: string;
  currentDisplayName: string;
  body: Record<string, unknown>;
}): ConnectorConfigResult {
  const { channel, body } = input;
  if (channel === PLATFORM_ONLY_CHANNEL) {
    throw ApiError.badRequest(
      "O conector Sankhya tem configuração própria e não passa por este caminho.",
      "SANKHYA_CONFIG_SEPARATE",
    );
  }
  const endpointInput = text(body.endpoint, 500);
  const endpoint = endpointInput ? validateConnectorEndpoint(channel, endpointInput) : "";
  const displayName = text(body.displayName, 120) || input.currentDisplayName;
  const status = body.status === "paused" ? "paused" as const : "needs_credentials" as const;
  const config = {
    ...(endpoint ? { endpoint } : {}),
    ...(body.requestBody ? { requestBody: safeRequestBody(body.requestBody) } : {}),
    ...((channel === "solides" || channel === "tangerino") && text(body.accountReference, 160)
      ? { accountReference: text(body.accountReference, 160) } : {}),
    ...(channel === "solides" || channel === "tangerino" ? admissionSyncConfig(body) : {}),
    ...(channel === "teams" ? teamsConfig(body) : {}),
  };
  return { displayName, status, config, configuredFields: Object.keys(config) };
}

/**
 * Empresa e quadro apontados pela configuração precisam ser deste workspace.
 *
 * `config_json` é texto livre: nenhuma chave estrangeira o protege, e o
 * isolamento por linha não olha para dentro de um JSON. Sem esta conferência,
 * um identificador de outro cliente entra gravado e só aparece muito depois —
 * na importação que falha por chave composta, ou pior, num relatório que soma
 * o que não devia. Quem grava pelo console da plataforma atravessa workspaces
 * o dia inteiro, então aqui o erro de digitação é plausível de verdade.
 *
 * A conferência vale para as duas portas: as regras são as mesmas dos dois
 * lados, e só muda quem pode abrir.
 */
export async function assertConnectorTargets(
  d1: Database, workspaceId: string, config: Record<string, unknown>,
) {
  const companyId = text(config.companyId, 80);
  const boardId = text(config.boardId, 80);
  if (!companyId && !boardId) return;
  const found = await d1.prepare(`SELECT
      (? = '' OR EXISTS (SELECT 1 FROM fdp_companies WHERE workspace_id = ? AND id = ?)) AS company_ok,
      (? = '' OR EXISTS (SELECT 1 FROM fdp_boards WHERE workspace_id = ? AND id = ?)) AS board_ok`)
    .bind(companyId, workspaceId, companyId, boardId, workspaceId, boardId)
    .first<{ company_ok: boolean; board_ok: boolean }>();
  if (!found?.company_ok) {
    throw ApiError.badRequest("A empresa selecionada não pertence a este workspace.", "CONNECTOR_COMPANY_INVALID");
  }
  if (!found?.board_ok) {
    throw ApiError.badRequest("O quadro selecionado não pertence a este workspace.", "CONNECTOR_BOARD_INVALID");
  }
}
