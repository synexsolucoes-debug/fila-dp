/**
 * Microsoft Teams como origem de movimentações de DP, configurado **por
 * workspace**.
 *
 * O problema estrutural que este módulo resolve: o segredo do webhook vinha de
 * uma variável de ambiente com um mapa `{workspaceId: segredo}`. Isso é
 * configuração global — conectar um cliente novo exigia editar a variável e
 * publicar de novo, o segredo de todos os clientes ficava num único lugar, e
 * girar o de um exigia mexer no de todos. Aqui o segredo passa a ser uma
 * credencial do workspace, guardada cifrada na mesma tabela e com a mesma
 * rotação de chave das demais (`fdp_integration_credentials`, tipo
 * `webhook_signing`, que o schema já previa e ninguém usava).
 *
 * A variável continua sendo aceita como fallback para não derrubar quem já está
 * instalado — mas ela deixa de ser o caminho normal.
 */
import { createHash, timingSafeEqual } from "node:crypto";
// Import de tipo apenas: o alias `@/db` só existe sob o resolvedor do Next, e
// carregá-lo de verdade impediria estes módulos de rodarem nos testes, que
// executam em Node puro.
import type { getD1 } from "@/db";
import { ApiError } from "./api-errors.ts";
import { openCredentials } from "./integrations.ts";
import { parseWorkspaceWebhookSecrets } from "./integration-security.ts";
import { log } from "./observability.ts";
import {
  interpretTeamsMessage, movementTaskDraft, plainTextFromTeams,
  type MovementKind, type TeamsInterpretation, type TeamsMessageOrigin,
} from "./teams-movements.ts";

/**
 * A conexão já escopada no workspace. É o mesmo tipo usado pelo motor de
 * integrações: reaproveitá-lo evita uma interface paralela que aceitaria uma
 * conexão sem tenant e devolveria zero linha em silêncio sob RLS.
 */
export type TeamsDatabase = ReturnType<typeof getD1>;

/** Configuração do conector Teams de um workspace. */
export type TeamsConfig = {
  tenantId: string;
  teamId: string;
  teamName: string;
  channelId: string;
  channelName: string;
  /** Movimentações que este workspace quer automatizar. */
  automations: Record<MovementKind, boolean>;
  boardId: string;
  companyId: string;
};

function textOf(value: unknown, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function parseTeamsConfig(raw: unknown): TeamsConfig {
  const config = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const automations = config.automations && typeof config.automations === "object"
    ? config.automations as Record<string, unknown>
    : {};
  return {
    tenantId: textOf(config.tenantId, 100),
    teamId: textOf(config.teamId, 200),
    teamName: textOf(config.teamName, 160),
    channelId: textOf(config.channelId, 200),
    channelName: textOf(config.channelName, 160),
    automations: {
      // Ausente conta como habilitada: quem conectou o Teams para automatizar
      // movimentações não precisa ligar duas chaves para isso funcionar.
      salary_change: automations.salary_change !== false,
      role_change: automations.role_change !== false,
    },
    boardId: textOf(config.boardId, 80),
    companyId: textOf(config.companyId, 80),
  };
}

function constantTimeEquals(received: string, expected: string) {
  if (!received || !expected) return false;
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  // Comparar tamanhos antes evita o throw do timingSafeEqual; o vazamento de
  // tamanho não ajuda quem ataca um segredo de 32+ bytes aleatórios.
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

/**
 * Segredo de assinatura do webhook deste workspace.
 *
 * Ordem: credencial do próprio workspace primeiro; variável de ambiente só como
 * compatibilidade. Nunca o contrário — senão um segredo de ambiente mal
 * configurado sobrescreveria a credencial correta do cliente.
 */
export async function resolveWebhookSecret(
  d1: TeamsDatabase,
  workspaceId: string,
  integrationId: string,
  channel: string,
): Promise<string> {
  const row = await d1.prepare(
    `SELECT encrypted_value, initialization_vector, auth_tag, key_version
       FROM fdp_integration_credentials
      WHERE workspace_id = ? AND integration_id = ? AND credential_type = 'webhook_signing' AND status = 'active'
      LIMIT 1`,
  ).bind(workspaceId, integrationId)
    .first<{ encrypted_value: string; initialization_vector: string; auth_tag: string; key_version: number }>();

  if (row) {
    const credentials = openCredentials(channel, {
      encryptedValue: row.encrypted_value,
      initializationVector: row.initialization_vector,
      authTag: row.auth_tag,
      keyVersion: row.key_version,
    });
    const secret = credentials.token ?? credentials.apiKey ?? "";
    if (secret) return secret;
  }

  const key = `FDP_${channel.toUpperCase()}_WEBHOOK_SECRET`;
  const mapped = parseWorkspaceWebhookSecrets(process.env[`${key}S`])[workspaceId];
  if (mapped) return mapped;
  const legacyWorkspaceId = String(process.env[`${key}_WORKSPACE_ID`] ?? "");
  if (legacyWorkspaceId && legacyWorkspaceId === workspaceId) return String(process.env[key] ?? "");
  return "";
}

/** Confere o segredo recebido contra o do workspace. */
export function assertWebhookSecret(received: string, expected: string) {
  if (!expected) {
    throw new ApiError(409, "WEBHOOK_SECRET_NOT_CONFIGURED",
      "Esta integração ainda não tem um segredo de webhook configurado. Gere um na tela de integrações do grupo antes de apontar o webhook para cá.");
  }
  if (!constantTimeEquals(received, expected)) {
    throw new ApiError(401, "WEBHOOK_UNAUTHORIZED", "Webhook não autorizado.");
  }
}

export type TeamsWebhookPayload = {
  teamId: string;
  teamName: string;
  channelId: string;
  channelName: string;
  messageId: string;
  messageUrl: string;
  senderName: string;
  text: string;
  /** Presente quando o Teams reentrega a mensagem depois de editada. */
  editedAt: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Extrai a mensagem do corpo enviado pelo Power Automate.
 *
 * O caminho oficial do Teams neste produto é um fluxo do Power Automate com o
 * gatilho "When a new channel message is added (V…)". Dois formatos precisam ser
 * aceitos, porque os dois aparecem na prática:
 *
 * 1. **Contrato recomendado** — o autor do fluxo monta um JSON limpo numa ação
 *    HTTP: `{ teamId, teamName, channelId, channelName, messageId, messageUrl,
 *    senderName, text }`. É o que a documentação instrui e o mais robusto.
 *
 * 2. **Corpo cru do gatilho** — quem apenas encaminha o `body` do gatilho manda
 *    a forma nativa do Graph: canal e time sob `channelIdentity`, remetente sob
 *    `from.user.displayName`, conteúdo sob `body.content` (HTML). Aceitar essa
 *    forma evita que o conector devolva "mensagem sem texto" para um fluxo
 *    montado do jeito mais óbvio.
 *
 * Nenhum campo aqui é confiável para roteamento de segurança: o workspace vem do
 * segredo conferido, não deste corpo. `teamId`/`channelId` servem só para casar
 * com o canal que o próprio workspace configurou.
 */
export function parseTeamsPayload(raw: Record<string, unknown>): TeamsWebhookPayload {
  // O gatilho do Power Automate entrega tudo sob `body`; um contrato limpo
  // entrega na raiz. Procurar nos dois cobre as duas montagens.
  const message = record(raw.message ?? raw.body);
  const channelIdentity = record(raw.channelIdentity ?? message.channelIdentity);
  const from = record(raw.from ?? message.from);
  const fromUser = record(from.user ?? from);
  // `body` pode ser a string do contrato limpo OU o objeto {contentType, content}
  // do gatilho; `message.body` cobre o caso do corpo cru aninhado.
  const messageBody = record(raw.body ?? message.body);

  return {
    teamId: textOf(raw.teamId ?? raw.teamAadGroupId ?? channelIdentity.teamId, 200),
    teamName: textOf(raw.teamName, 160),
    channelId: textOf(raw.channelId ?? channelIdentity.channelId, 200),
    channelName: textOf(raw.channelName, 160),
    messageId: textOf(raw.messageId ?? message.id ?? raw.id, 200),
    messageUrl: textOf(raw.messageUrl ?? raw.webUrl ?? message.webUrl, 500),
    senderName: textOf(raw.senderName ?? fromUser.displayName ?? from.displayName ?? raw.sender, 160),
    text: plainTextFromTeams(
      typeof raw.text === "string" ? raw.text
        : typeof raw.body === "string" ? raw.body
          : typeof message.content === "string" ? message.content
            : typeof messageBody.content === "string" ? messageBody.content
              : "",
    ),
    editedAt: textOf(raw.editedAt ?? message.lastEditedDateTime ?? message.lastModifiedDateTime, 40),
  };
}

/**
 * A mensagem veio do canal que este workspace mandou monitorar?
 *
 * Um workspace que monitora o canal "Movimentações" não deve receber demanda a
 * partir de qualquer canal da organização — e "não usar um canal global para
 * todos os clientes" é justamente o requisito. Quando o workspace ainda não
 * configurou canal, aceita: é o estado de quem acabou de conectar e ainda vai
 * escolher.
 */
export function matchesConfiguredChannel(config: TeamsConfig, payload: TeamsWebhookPayload) {
  if (config.channelId && payload.channelId && config.channelId !== payload.channelId) return false;
  if (config.teamId && payload.teamId && config.teamId !== payload.teamId) return false;
  return true;
}

/** Identificador estável do evento — a base da idempotência da mensagem. */
export function teamsEventId(payload: TeamsWebhookPayload, rawBody: string) {
  if (payload.messageId) {
    // A edição é um evento novo do ponto de vista do provedor, mas deve
    // reencontrar a mensagem original em vez de abrir outra demanda; por isso o
    // carimbo de edição entra na chave e o tratamento de edição é explícito.
    return payload.editedAt ? `teams:${payload.messageId}:${payload.editedAt}` : `teams:${payload.messageId}`;
  }
  return `teams:hash:${createHash("sha256").update(rawBody).digest("hex")}`;
}

type DemandTarget = {
  boardId: string;
  listId: string;
  slaBehavior: string;
  companyId: string | null;
  companyName: string;
};

/** Quadro e coluna de entrada onde a demanda automática nasce. */
export async function loadDemandTarget(d1: TeamsDatabase, workspaceId: string, config: TeamsConfig): Promise<DemandTarget> {
  const target = await d1.prepare(
    `SELECT board.id AS board_id, list.id AS list_id, list.sla_behavior
       FROM fdp_boards board
       JOIN fdp_lists list ON list.workspace_id = board.workspace_id AND list.board_id = board.id AND list.kind = 'new'
      WHERE board.workspace_id = ? AND (? = '' OR board.id = ?)
      ORDER BY board.created_at, board.name LIMIT 1`,
  ).bind(workspaceId, config.boardId, config.boardId)
    .first<{ board_id: string; list_id: string; sla_behavior: string }>();
  if (!target) {
    throw new ApiError(409, "INTEGRATION_TARGET_BOARD_MISSING",
      "Configure um quadro com coluna de entrada para receber as movimentações do Teams.");
  }
  const company = config.companyId
    ? await d1.prepare("SELECT id, trade_name, legal_name FROM fdp_companies WHERE workspace_id = ? AND id = ?")
      .bind(workspaceId, config.companyId).first<{ id: string; trade_name: string; legal_name: string }>()
    : null;
  if (config.companyId && !company) {
    throw new ApiError(409, "INTEGRATION_TARGET_COMPANY_MISSING",
      "A empresa configurada para as movimentações do Teams não existe neste grupo.");
  }
  return {
    boardId: target.board_id,
    listId: target.list_id,
    slaBehavior: target.sla_behavior,
    companyId: company?.id ?? null,
    companyName: company ? (company.trade_name || company.legal_name) : "",
  };
}

/**
 * Colaboradores do workspace, para a interpretação reconhecer o nome citado.
 *
 * Casar com o cadastro é a evidência mais forte de que a mensagem fala de gente
 * real. A consulta é limitada e escopada ao workspace — nome de colaborador de
 * um cliente jamais participa da interpretação de outro.
 */
export async function loadEmployeeNames(d1: TeamsDatabase, workspaceId: string) {
  const rows = await d1.prepare(
    "SELECT id, full_name FROM fdp_employees WHERE workspace_id = ? AND employment_status <> 'terminated' ORDER BY full_name LIMIT 2000",
  ).bind(workspaceId).all<{ id: string; full_name: string }>();
  return rows.results.map((row) => ({ id: String(row.id), name: String(row.full_name) }));
}

function matchEmployee(employees: { id: string; name: string }[], name: string) {
  if (!name) return null;
  const folded = name.normalize("NFD").replace(/[̀-ͯ]/gu, "").toLowerCase();
  return employees.find((employee) => {
    const other = employee.name.normalize("NFD").replace(/[̀-ͯ]/gu, "").toLowerCase();
    return other === folded || other.includes(folded) || folded.includes(other);
  }) ?? null;
}

export type TeamsProcessingResult =
  | { outcome: "card"; cardId: string; kind: MovementKind; confidence: number }
  | { outcome: "suggestion"; suggestionId: string; kind: MovementKind; confidence: number; missing: string[] }
  | { outcome: "ignored"; reason: string };

/**
 * Transforma uma mensagem do canal monitorado em demanda, sugestão, ou nada.
 *
 * A decisão vem de `interpretTeamsMessage`; aqui só se faz o efeito. A
 * separação é o que permite testar a interpretação contra o texto real do
 * cliente sem banco nenhum.
 */
export async function processTeamsMessage(
  d1: TeamsDatabase,
  input: {
    workspaceId: string;
    integrationId: string;
    eventId: string;
    config: TeamsConfig;
    payload: TeamsWebhookPayload;
  },
): Promise<TeamsProcessingResult> {
  const { workspaceId, integrationId, payload, config } = input;

  if (!matchesConfiguredChannel(config, payload)) {
    return { outcome: "ignored", reason: "mensagem publicada fora do canal monitorado por este grupo" };
  }
  if (!payload.text) {
    return { outcome: "ignored", reason: "mensagem sem texto utilizável" };
  }

  const employees = await loadEmployeeNames(d1, workspaceId);
  const interpretation = interpretTeamsMessage(payload.text, employees.map((employee) => employee.name));

  if (!interpretation.kind || interpretation.decision === "ignore") {
    return { outcome: "ignored", reason: interpretation.kind
      ? `movimentação reconhecida com confiança insuficiente (${Math.round(interpretation.confidence * 100)}%)`
      : "a mensagem não descreve uma movimentação de pessoal" };
  }
  if (!config.automations[interpretation.kind]) {
    return { outcome: "ignored", reason: `a automação de ${interpretation.kind === "salary_change" ? "alteração salarial" : "alteração de cargo"} está desligada neste grupo` };
  }

  const employee = matchEmployee(employees, interpretation.employeeName);
  const origin: TeamsMessageOrigin = {
    senderName: payload.senderName,
    teamName: payload.teamName || config.teamName,
    channelName: payload.channelName || config.channelName,
    messageId: payload.messageId,
    messageUrl: payload.messageUrl,
    originalText: payload.text,
  };

  if (interpretation.decision === "review") {
    const suggestionId = await upsertSuggestion(d1, { ...input, interpretation, employeeId: employee?.id ?? null, origin });
    return {
      outcome: "suggestion", suggestionId, kind: interpretation.kind,
      confidence: interpretation.confidence, missing: interpretation.missing,
    };
  }

  const cardId = await createMovementCard(d1, { workspaceId, integrationId, config, interpretation, origin, employeeId: employee?.id ?? null });
  log("info", "integration.demand_created", { workspaceId, connectorId: integrationId }, {
    source: "teams", movementKind: interpretation.kind, cardId, confidence: interpretation.confidence,
  });
  return { outcome: "card", cardId, kind: interpretation.kind, confidence: interpretation.confidence };
}

function salaryCents(value: number | null) {
  return value === null ? null : Math.round(value * 100);
}

/**
 * Grava a sugestão, ou atualiza a que a mesma mensagem já havia gerado.
 *
 * Mensagem editada no Teams precisa corrigir a sugestão pendente em vez de
 * empilhar uma segunda: o índice parcial em (workspace, integração, mensagem)
 * para sugestões pendentes é o que torna o `ON CONFLICT` possível.
 */
async function upsertSuggestion(d1: TeamsDatabase, input: {
  workspaceId: string; integrationId: string; eventId: string;
  interpretation: TeamsInterpretation; employeeId: string | null; origin: TeamsMessageOrigin;
  payload: TeamsWebhookPayload;
}) {
  const { interpretation: reading, origin, payload } = input;
  const id = crypto.randomUUID();
  const row = await d1.prepare(
    `INSERT INTO fdp_movement_suggestions
       (id, workspace_id, integration_id, event_id, movement_kind, status, confidence, employee_name, employee_id,
        previous_salary_cents, new_salary_cents, previous_role, new_role, effective_date, requested_by_name,
        team_id, team_name, channel_id, channel_name, message_id, message_url, original_message,
        missing_fields_json, signals_json)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb)
     ON CONFLICT (workspace_id, integration_id, message_id) WHERE message_id <> '' AND status = 'pending'
     DO UPDATE SET
       confidence = excluded.confidence,
       employee_name = excluded.employee_name,
       employee_id = excluded.employee_id,
       previous_salary_cents = excluded.previous_salary_cents,
       new_salary_cents = excluded.new_salary_cents,
       previous_role = excluded.previous_role,
       new_role = excluded.new_role,
       effective_date = excluded.effective_date,
       original_message = excluded.original_message,
       missing_fields_json = excluded.missing_fields_json,
       signals_json = excluded.signals_json,
       updated_at = CURRENT_TIMESTAMP
     RETURNING id`,
  ).bind(
    id, input.workspaceId, input.integrationId, input.eventId, reading.kind, Math.round(reading.confidence * 100),
    reading.employeeName, input.employeeId,
    salaryCents(reading.previousSalary), salaryCents(reading.newSalary),
    reading.previousRole, reading.newRole, reading.effectiveDate || null, origin.senderName,
    payload.teamId, origin.teamName, payload.channelId, origin.channelName,
    payload.messageId, payload.messageUrl, origin.originalText,
    JSON.stringify(reading.missing), JSON.stringify(reading.signals),
  ).first<{ id: string }>();
  return row?.id ?? id;
}

/** Demanda de movimentação, com checklist do processo correspondente. */
async function createMovementCard(d1: TeamsDatabase, input: {
  workspaceId: string; integrationId: string; config: TeamsConfig;
  interpretation: TeamsInterpretation; origin: TeamsMessageOrigin; employeeId: string | null;
}) {
  const target = await loadDemandTarget(d1, input.workspaceId, input.config);
  const draft = movementTaskDraft(input.interpretation, input.origin);
  const cardId = crypto.randomUUID();

  await d1.prepare(
    `INSERT INTO fdp_cards
       (id, workspace_id, board_id, list_id, title, description, company_id, company, process_type, priority,
        position, source_type, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal',
        COALESCE((SELECT MAX(position) FROM fdp_cards WHERE list_id = ? AND archived = 0), 0) + 1000,
        'integration', ?)`,
  ).bind(
    cardId, input.workspaceId, target.boardId, target.listId,
    draft.title, draft.description, target.companyId, target.companyName,
    draft.processType, target.listId, "integracao:teams",
  ).run();

  await d1.batch(draft.checklist.map((item, index) => d1.prepare(
    "INSERT INTO fdp_checklist_items (id, workspace_id, card_id, title, completed, position) VALUES (?, ?, ?, ?, 0, ?)",
  ).bind(crypto.randomUUID(), input.workspaceId, cardId, item, (index + 1) * 1000)));

  return cardId;
}
