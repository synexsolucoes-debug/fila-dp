/**
 * Idempotência global (§8).
 *
 * O produto já tinha três mecanismos corretos e desconectados: a central de
 * eventos de integração (`fdp_integration_events`), os registros da API pública
 * (`fdp_api_idempotency_records`) e o `ON CONFLICT` de cada entrega de webhook.
 * Cada um resolvia a mesma pergunta com um vocabulário próprio, e o quarto
 * ponto de entrada — o agente — não tinha nenhum.
 *
 * Este módulo é a resposta comum: como derivar a chave que identifica **a
 * ocorrência** e não a execução. Ele não substitui as três tabelas; substitui a
 * decisão ad hoc de "que string eu uso como chave aqui?", que é onde o erro
 * nasce. Duas entregas do mesmo webhook precisam produzir a mesma string, e uma
 * reexecução deliberada precisa produzir uma diferente — nessa ordem de
 * importância.
 *
 * Regra de ouro deste arquivo: nada que varie por execução entra na chave.
 * Nem `Date.now()`, nem `randomUUID()`, nem o número da tentativa.
 */
import { createHash } from "node:crypto";

const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

/**
 * Identificação da ocorrência.
 *
 * `externalId` é o melhor sinal e vence os demais: quando a origem numera a
 * mensagem, é a numeração dela que decide o que é repetição. Sem ele, o hash do
 * corpo serve — mas só o corpo, nunca cabeçalhos de entrega, que mudam a cada
 * reenvio do mesmo fato.
 */
export type OccurrenceIdentity = {
  workspaceId: string;
  /** Canal ou agente de origem: `teams`, `solides`, `tangerino`, `api`, `import`… */
  source: string;
  /** Tipo do que chegou, para que dois fatos diferentes da mesma origem não colidam. */
  kind: string;
  externalId?: string | null;
  /** Corpo cru, usado apenas quando não existe identificador de origem. */
  payload?: string | null;
  /** Discriminante extra e estável (competência, entidade). Nunca instante de execução. */
  scope?: readonly (string | null | undefined)[];
};

export function hashPayload(payload: string) {
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Chave de idempotência da ocorrência.
 *
 * Devolve string vazia quando não há como identificar a ocorrência — e quem
 * chama **precisa** tratar isso como recusa, não como "então segue sem chave".
 * Aceitar um evento sem identidade é aceitar duplicar trabalho de DP.
 */
export function occurrenceKey(identity: OccurrenceIdentity): string {
  const workspaceId = text(identity.workspaceId, 100);
  const source = text(identity.source, 40);
  const kind = text(identity.kind, 80);
  if (!workspaceId || !source || !kind) return "";

  const external = text(identity.externalId, 300);
  const discriminator = external || (identity.payload ? `hash:${hashPayload(identity.payload)}` : "");
  if (!discriminator) return "";

  const scope = (identity.scope ?? []).map((item) => text(item, 120)).filter(Boolean);
  const material = [workspaceId, source, kind, discriminator, ...scope].join(" ");
  return createHash("sha256").update(material).digest("hex").slice(0, 64);
}

/**
 * Identificador externo no formato que `fdp_integration_events` espera.
 *
 * O prefixo com o canal existe porque a coluna é única por
 * `(workspace, integração, external_event_id)`: sem ele, duas integrações do
 * mesmo canal poderiam receber o mesmo número de mensagem e uma delas seria
 * silenciosamente descartada como repetição.
 */
export function externalEventId(source: string, identifier: string, payload?: string) {
  const channel = text(source, 40) || "unknown";
  const id = text(identifier, 200);
  if (id) return `${channel}:${id}`;
  return payload ? `${channel}:hash:${hashPayload(payload)}` : "";
}

/**
 * Reprocessamento deliberado (§8).
 *
 * Reprocessar é justamente querer um resultado novo para a mesma ocorrência.
 * A chave carrega então o número da tentativa — que é estável dentro daquela
 * tentativa e diferente da anterior. Sem isso, "reprocessar" não faria nada e
 * pareceria um defeito.
 */
export function reprocessKey(baseKey: string, attempt: number) {
  const base = text(baseKey, 64);
  if (!base) return "";
  const safeAttempt = Math.max(0, Math.trunc(Number(attempt) || 0));
  return safeAttempt === 0 ? base : createHash("sha256").update(`${base}#${safeAttempt}`).digest("hex").slice(0, 64);
}
