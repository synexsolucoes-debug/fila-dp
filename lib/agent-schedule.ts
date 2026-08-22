/**
 * Cadência, atraso e saúde dos agentes (§27 a §35, §83, §84, §87).
 *
 * Este arquivo é puro de propósito: sem banco, sem `fetch`, sem relógio
 * implícito. Quem chama informa o instante. É o que permite ensaiar "duas
 * execuções no mesmo minuto", "terceira falha seguida" e "22h de sexta em
 * São Paulo" sem esperar o tempo passar — e são exatamente esses os casos em
 * que um agendador erra em produção e ninguém percebe por semanas.
 *
 * ## O que **não** existe aqui
 *
 * Nenhuma tabela nova e nenhum runner novo. A execução recorrente é a fila que
 * já existe — `fdp_integration_jobs`, com `available_at`, `lease_token`,
 * `lease_expires_at`, `attempt`/`max_attempts` e `dead_letter` — drenada pela
 * varredura agendada que já roda. O que faltava não era infraestrutura: era
 * **quando** enfileirar, e o que fazer quando o sistema de origem está fora do
 * ar. É só isso que este módulo decide.
 */

/* -------------------------------------------------------------------------- *
 * Cadência
 * -------------------------------------------------------------------------- */

export type AgentCadence =
  | "manual"
  | "every_15_minutes"
  | "every_30_minutes"
  | "hourly"
  | "business_hours"
  | "daily";

export type AgentCadenceDefinition = {
  key: AgentCadence;
  label: string;
  /** Intervalo entre execuções. `0` significa "só quando alguém pedir". */
  intervalMinutes: number;
  /** Só enfileira dentro do expediente do grupo. */
  businessHoursOnly: boolean;
  description: string;
};

/**
 * Frequência mínima (§30).
 *
 * Quinze minutos não é um número bonito: é o menor intervalo em que a varredura
 * de meia em meia hora ainda tem sentido, e o menor que não transforma um
 * provedor externo com limite de requisições em um incidente nosso. Cadência
 * abaixo disso é recusada na entrada, não corrigida em silêncio — corrigir em
 * silêncio esconde de quem configurou que o pedido não foi atendido.
 */
export const MINIMUM_INTERVAL_MINUTES = 15;

export const agentCadences: readonly AgentCadenceDefinition[] = [
  {
    key: "manual",
    label: "Somente manual",
    intervalMinutes: 0,
    businessHoursOnly: false,
    description: "O agente só roda quando alguém clica em Executar agora.",
  },
  {
    key: "every_15_minutes",
    label: "A cada 15 minutos",
    intervalMinutes: 15,
    businessHoursOnly: false,
    description: "Para origens que mudam durante todo o dia e cujo atraso custa caro.",
  },
  {
    key: "every_30_minutes",
    label: "A cada 30 minutos",
    intervalMinutes: 30,
    businessHoursOnly: false,
    description: "Acompanha a varredura agendada, sem folga entre um ciclo e outro.",
  },
  {
    key: "hourly",
    label: "De hora em hora",
    intervalMinutes: 60,
    businessHoursOnly: false,
    description: "Suficiente para origens que consolidam dados ao longo do dia.",
  },
  {
    key: "business_hours",
    label: "De hora em hora, no expediente",
    intervalMinutes: 60,
    businessHoursOnly: true,
    description: "Não bate no sistema de origem de madrugada nem no fim de semana.",
  },
  {
    key: "daily",
    label: "Uma vez por dia",
    intervalMinutes: 60 * 24,
    businessHoursOnly: true,
    description: "Para origens que só mudam de verdade uma vez por dia.",
  },
] as const;

const CADENCE_BY_KEY = new Map(agentCadences.map((item) => [item.key, item]));

export function isAgentCadence(value: unknown): value is AgentCadence {
  return typeof value === "string" && CADENCE_BY_KEY.has(value as AgentCadence);
}

export function agentCadence(value: unknown): AgentCadenceDefinition {
  return CADENCE_BY_KEY.get(String(value) as AgentCadence) ?? CADENCE_BY_KEY.get("manual")!;
}

/* -------------------------------------------------------------------------- *
 * Expediente e fuso
 * -------------------------------------------------------------------------- */

/** Fuso padrão quando o grupo não configurou o próprio (§84). */
export const DEFAULT_TIMEZONE = "America/Sao_Paulo";

/** Janela do expediente, em hora local do grupo. */
const BUSINESS_START_HOUR = 8;
const BUSINESS_END_HOUR = 18;

/**
 * Hora e dia da semana em um fuso, sem biblioteca de data.
 *
 * `Intl` já sabe converter, inclusive horário de verão; escrever a conta à mão
 * seria reimplementar a base de fusos e errar nela. Um fuso inválido não pode
 * derrubar o agendador — a origem do valor é uma configuração de cliente — então
 * a recusa cai no padrão em vez de estourar.
 */
export function localParts(instant: Date, timeZone: string) {
  const zone = timeZone && timeZone.trim() ? timeZone.trim() : DEFAULT_TIMEZONE;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit",
    });
    const parts = new Map(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
    const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const hour = Number(parts.get("hour") ?? "0") % 24;
    return {
      hour,
      minute: Number(parts.get("minute") ?? "0"),
      weekday: Math.max(0, weekdays.indexOf(String(parts.get("weekday") ?? "Sun"))),
      timeZone: zone,
    };
  } catch {
    return localParts(instant, DEFAULT_TIMEZONE);
  }
}

/** Segunda a sexta, entre 8h e 18h na hora local do grupo. */
export function withinBusinessHours(instant: Date, timeZone: string) {
  const { hour, weekday } = localParts(instant, timeZone);
  return weekday >= 1 && weekday <= 5 && hour >= BUSINESS_START_HOUR && hour < BUSINESS_END_HOUR;
}

/* -------------------------------------------------------------------------- *
 * Próxima execução
 * -------------------------------------------------------------------------- */

const MINUTE_MS = 60_000;

/**
 * Quando o agente deve rodar de novo.
 *
 * Cadência `manual` não devolve horário nenhum: quem escolheu manual não quer
 * que o sistema decida por ele. Cadência de expediente avança de hora em hora
 * até cair dentro do expediente — o passo é pequeno para o cálculo continuar
 * correto na virada do horário de verão, em que "somar 12 horas" pula ou repete
 * uma hora.
 */
export function nextRunAt(input: {
  cadence: AgentCadence | string;
  from: Date;
  timeZone?: string;
}): Date | null {
  const cadence = agentCadence(input.cadence);
  if (cadence.intervalMinutes <= 0) return null;
  const zone = input.timeZone || DEFAULT_TIMEZONE;

  const candidate = new Date(input.from.getTime() + cadence.intervalMinutes * MINUTE_MS);
  if (!cadence.businessHoursOnly) return candidate;

  // No máximo uma semana de avanço: um fuso patológico não pode virar laço.
  const limit = 24 * 7;
  let cursor = candidate;
  for (let step = 0; step < limit; step += 1) {
    if (withinBusinessHours(cursor, zone)) return cursor;
    cursor = new Date(cursor.getTime() + 60 * MINUTE_MS);
  }
  return cursor;
}

/* -------------------------------------------------------------------------- *
 * Falha, espera e degradação
 * -------------------------------------------------------------------------- */

/**
 * Espera depois de falhar (§33).
 *
 * 1, 5, 15 e 60 minutos. O teto é uma hora porque acima disso o agente
 * praticamente para, e parar em silêncio é o que §34 proíbe: o que acontece
 * depois da quarta falha não é esperar mais, é acender o sinal de degradado.
 */
export const BACKOFF_MINUTES = [1, 5, 15, 60] as const;

export function backoffMinutes(consecutiveFailures: number): number {
  const failures = Math.max(1, Math.trunc(consecutiveFailures) || 1);
  return BACKOFF_MINUTES[Math.min(failures, BACKOFF_MINUTES.length) - 1];
}

/**
 * Falhas seguidas até o agente ser declarado degradado (§34).
 *
 * Três, e não uma: retentativa é comportamento normal de rede, e acender alarme
 * na primeira ensina a equipe a ignorar o alarme. Três falhas seguidas já não
 * são coincidência.
 */
export const DEGRADED_AFTER_FAILURES = 3;

/**
 * Atraso tolerado antes de o agente ser considerado atrasado (§52).
 *
 * A varredura roda a cada meia hora; um agente cujo horário previsto passou há
 * mais de um ciclo não está "quase lá", está sem ser drenado.
 */
export const LATE_AFTER_MINUTES = 30;

export type AgentHealth =
  /** Nunca rodou: não é erro, é configuração incompleta. */
  | "never_run"
  /** Kill switch acionado por uma pessoa. */
  | "paused"
  /** O conector não tem credencial utilizável. */
  | "needs_credentials"
  /** Última execução falhou. */
  | "error"
  /** Falhou seguidas vezes: continua tentando, mas não se pode confiar nele. */
  | "degraded"
  /** O horário previsto passou e a execução não veio. */
  | "late"
  | "active";

export type AgentHealthInput = {
  status: string;
  scheduleEnabled: boolean;
  cadence: AgentCadence | string;
  lastRunAt: string | Date | null;
  nextRunAt: string | Date | null;
  consecutiveFailures: number;
  lastRunFailed: boolean;
  now: Date;
};

const asDate = (value: string | Date | null) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Estado real do agente (§22).
 *
 * A ordem importa e é a da consequência, não a do alfabeto: pausado vence tudo
 * porque foi uma decisão humana; sem credencial vence erro porque explica o
 * erro; degradado vence atrasado porque atraso é sintoma e degradação é a
 * causa. Nada aqui é inferido só do relógio sem regra escrita — "não rodou hoje"
 * não vira estado; "o horário previsto passou de um ciclo" vira, e o ciclo está
 * declarado logo acima.
 */
export function agentHealth(input: AgentHealthInput): AgentHealth {
  if (input.status === "paused") return "paused";
  if (input.status === "needs_credentials") return "needs_credentials";
  if (input.consecutiveFailures >= DEGRADED_AFTER_FAILURES) return "degraded";
  if (input.lastRunFailed || input.status === "error") return "error";
  if (!asDate(input.lastRunAt)) return "never_run";

  const next = asDate(input.nextRunAt);
  const scheduled = input.scheduleEnabled && agentCadence(input.cadence).intervalMinutes > 0;
  if (scheduled && next && next.getTime() + LATE_AFTER_MINUTES * MINUTE_MS < input.now.getTime()) {
    return "late";
  }
  return "active";
}

/** Rótulo e tom para a tela. O usuário operacional não lê enum. */
export const agentHealthLabels: Record<AgentHealth, { label: string; tone: "critical" | "warning" | "neutral" | "positive"; detail: string }> = {
  never_run: { label: "Nunca executado", tone: "neutral", detail: "Este agente ainda não foi executado neste grupo." },
  paused: { label: "Pausado", tone: "warning", detail: "Alguém pausou este agente. Nenhuma leitura é feita enquanto ele estiver assim." },
  needs_credentials: { label: "Sem credencial", tone: "warning", detail: "O conector não tem uma credencial válida. Configure-a antes de agendar." },
  error: { label: "Erro na última execução", tone: "critical", detail: "A última execução falhou. O agente tentará de novo, com espera crescente." },
  degraded: { label: "Degradado", tone: "critical", detail: "Falhas seguidas. O agente continua tentando, mas o dado pode estar desatualizado." },
  late: { label: "Atrasado", tone: "warning", detail: "O horário previsto passou e a execução não aconteceu. Verifique a varredura agendada." },
  active: { label: "Ativo", tone: "positive", detail: "Executando na cadência configurada." },
};

/* -------------------------------------------------------------------------- *
 * Elegibilidade
 * -------------------------------------------------------------------------- */

export type AgentEligibilityReason =
  | "ok"
  | "paused"
  | "not_connected"
  | "schedule_disabled"
  | "manual_only"
  | "outside_business_hours"
  | "not_due"
  | "already_queued";

/**
 * O agente deve entrar na fila agora? (§87)
 *
 * Custo é o motivo desta função existir separada da consulta: enfileirar
 * execução de agente pausado, sem credencial ou sem cadência gasta janela da
 * varredura, gasta requisição no provedor externo e enche a fila de trabalho
 * que vai falhar. A recusa é nomeada para que a tela consiga dizer por que
 * aquele agente não roda — "não está agendado" e "está fora do expediente" são
 * respostas diferentes para quem espera o dado chegar.
 */
export function agentIsDue(input: {
  status: string;
  scheduleEnabled: boolean;
  cadence: AgentCadence | string;
  nextRunAt: string | Date | null;
  hasActiveJob: boolean;
  timeZone?: string;
  now: Date;
}): { due: boolean; reason: AgentEligibilityReason } {
  if (input.status === "paused") return { due: false, reason: "paused" };
  if (input.status !== "connected") return { due: false, reason: "not_connected" };
  if (input.hasActiveJob) return { due: false, reason: "already_queued" };
  if (!input.scheduleEnabled) return { due: false, reason: "schedule_disabled" };

  const cadence = agentCadence(input.cadence);
  if (cadence.intervalMinutes <= 0) return { due: false, reason: "manual_only" };
  if (cadence.businessHoursOnly && !withinBusinessHours(input.now, input.timeZone || DEFAULT_TIMEZONE)) {
    return { due: false, reason: "outside_business_hours" };
  }

  const next = asDate(input.nextRunAt);
  // Sem horário previsto o agente acabou de ser agendado: roda no primeiro
  // ciclo em vez de esperar alguém preencher a data à mão.
  if (next && next.getTime() > input.now.getTime()) return { due: false, reason: "not_due" };
  return { due: true, reason: "ok" };
}

/* -------------------------------------------------------------------------- *
 * Idempotência da execução agendada
 * -------------------------------------------------------------------------- */

/**
 * Chave da execução agendada.
 *
 * Deriva da janela de tempo, e não do instante: duas varreduras dentro do mesmo
 * intervalo produzem a mesma chave e, portanto, uma execução só. Nada que varie
 * por chamada — relógio exato, UUID — entra aqui, pela mesma razão de sempre:
 * chave que muda a cada tentativa não é chave de idempotência, é enfeite.
 */
export function scheduledRunKey(input: { agentKey: string; cadence: AgentCadence | string; at: Date }) {
  const cadence = agentCadence(input.cadence);
  const windowMs = Math.max(cadence.intervalMinutes, MINIMUM_INTERVAL_MINUTES) * MINUTE_MS;
  const slot = Math.floor(input.at.getTime() / windowMs) * windowMs;
  return `agent:${input.agentKey}:${new Date(slot).toISOString()}`;
}

/** Chave da execução manual: a janela é curta para o botão não virar spam (§24). */
export const MANUAL_RUN_WINDOW_MINUTES = 5;

export function manualRunKey(input: { agentKey: string; at: Date }) {
  const windowMs = MANUAL_RUN_WINDOW_MINUTES * MINUTE_MS;
  const slot = Math.floor(input.at.getTime() / windowMs) * windowMs;
  return `agent:manual:${input.agentKey}:${new Date(slot).toISOString()}`;
}
