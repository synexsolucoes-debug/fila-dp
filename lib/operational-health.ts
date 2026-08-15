import { getD1, getScopedD1 } from "../db/index.ts";

/**
 * Saúde operacional: fila de integrações, conectores e entregas de webhook.
 *
 * O que motivou este módulo: a varredura agendada das integrações ficou
 * quebrada em produção com `syntax error at or near "grant"`, meia em meia
 * hora, e `/api/health` respondia 200 com "Banco na mesma versão do
 * aplicativo". O relatório de prontidão só olhava aplicação, schema e
 * configuração — nada que falasse do trabalho que o produto precisa executar.
 * Um sistema que se declara saudável enquanto a fila de todos os clientes está
 * parada não é um health check, é um enfeite.
 *
 * O que este módulo mede é sintoma, não causa: fila que não anda, job preso,
 * conector em erro, entrega acumulada. Qualquer que seja o defeito por trás —
 * SQL inválido, credencial vencida, worker fora do ar — o sintoma aparece.
 */

export type HealthSeverity = "saudavel" | "atencao" | "degradado" | "critico";

/** Ordem de gravidade, para consolidar vários sinais em um veredito só. */
const SEVERITY_ORDER: readonly HealthSeverity[] = ["saudavel", "atencao", "degradado", "critico"];

export function worstSeverity(...severities: HealthSeverity[]): HealthSeverity {
  return severities.reduce((worst, current) =>
    SEVERITY_ORDER.indexOf(current) > SEVERITY_ORDER.indexOf(worst) ? current : worst, "saudavel");
}

/**
 * A varredura roda aos minutos 17 e 47 — um ciclo é meia hora. Um job que
 * continua disponível depois de dois ciclos indica que o executor não está
 * drenando; depois de três, a fila está parada de fato. Foi exatamente esse o
 * padrão do incidente, e é ele que precisa acender antes do cliente ligar.
 */
const CYCLE_MINUTES = 30;
const DELAYED_AFTER_MINUTES = CYCLE_MINUTES * 2;
const STALLED_AFTER_MINUTES = CYCLE_MINUTES * 3;
/** Janela das contagens de falha: um dia mostra tendência sem virar histórico. */
const RECENT_WINDOW_HOURS = 24;
/** Falhas recentes toleradas antes de degradar: retentativa é normal, repetição não. */
const RECENT_FAILURE_BUDGET = 10;
/**
 * Teto de workspaces varridos por chamada. As tabelas da fila têm FORCE RLS e
 * não há política de plataforma sobre elas — a agregação percorre tenant a
 * tenant, então o teto é o que impede o health check de virar o endpoint mais
 * caro do produto quando a base crescer.
 */
const MAX_WORKSPACES_SCANNED = 200;
/** Monitores externos batem neste endpoint sem parar; o resultado vale por este tempo. */
const CACHE_TTL_MS = 15_000;

export type QueueHealth = {
  /** Jobs aguardando execução dentro do prazo. */
  pending: number;
  /** Disponíveis há mais de dois ciclos: o executor não está drenando. */
  delayed: number;
  /** Arrendados com lease vencido: o worker morreu no meio do trabalho. */
  stuck: number;
  /** Esgotaram as tentativas. Exigem decisão humana, não esperam sozinhos. */
  deadLetter: number;
  failuresLast24h: number;
  lastCompletedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
};

export type ConnectorHealth = {
  connected: number;
  failing: number;
  /** Conectores agendados cujo horário passou há mais de um ciclo. */
  overdue: number;
  lastSyncAt: string | null;
};

export type WebhookHealth = {
  pending: number;
  failed: number;
  deadLetter: number;
  deliveredLast24h: number;
};

export type OperationalHealth = {
  severity: HealthSeverity;
  /** Frase pronta para quem opera, sem detalhe técnico. */
  detail: string;
  workspacesScanned: number;
  /** Verdadeiro quando a base passou do teto: o retrato é parcial. */
  truncated: boolean;
  queue: QueueHealth;
  connectors: ConnectorHealth;
  webhooks: WebhookHealth;
  /** Falhas por tenant, só para quem administra a plataforma. */
  failingWorkspaces?: string[];
};

type Counters = { queue: QueueHealth; connectors: ConnectorHealth; webhooks: WebhookHealth };

const emptyCounters = (): Counters => ({
  queue: { pending: 0, delayed: 0, stuck: 0, deadLetter: 0, failuresLast24h: 0, lastCompletedAt: null, lastSuccessAt: null, lastFailureAt: null },
  connectors: { connected: 0, failing: 0, overdue: 0, lastSyncAt: null },
  webhooks: { pending: 0, failed: 0, deadLetter: 0, deliveredLast24h: 0 },
});

const latest = (left: string | null, right: string | null) =>
  !left ? right : !right ? left : left > right ? left : right;

/**
 * Traduz os números em um veredito.
 *
 * A regra que importa: fila parada é crítico. Não "atenção" — o produto
 * inteiro depende da fila andar, e o incidente que originou este módulo passou
 * despercebido justamente porque nada classificava isso como grave.
 */
export function classifyOperationalHealth(counters: Counters): { severity: HealthSeverity; detail: string } {
  const { queue, connectors, webhooks } = counters;

  if (queue.deadLetter > 0) {
    return {
      severity: "critico",
      detail: `${queue.deadLetter} ${queue.deadLetter === 1 ? "execução esgotou" : "execuções esgotaram"} as tentativas e não seguirão sozinhas. Reprocesse pela central de integrações.`,
    };
  }
  if (queue.delayed > 0) {
    return {
      severity: "critico",
      detail: `A fila de integrações não está sendo drenada: ${queue.delayed} ${queue.delayed === 1 ? "execução aguarda" : "execuções aguardam"} há mais de ${DELAYED_AFTER_MINUTES} minutos. Verifique a varredura agendada.`,
    };
  }
  if (queue.stuck > 0) {
    return {
      severity: "degradado",
      detail: `${queue.stuck} ${queue.stuck === 1 ? "execução ficou presa" : "execuções ficaram presas"} com reserva vencida. Elas voltam à fila na próxima varredura.`,
    };
  }
  if (connectors.failing > 0) {
    return {
      severity: "degradado",
      detail: `${connectors.failing} ${connectors.failing === 1 ? "integração está" : "integrações estão"} em erro. Consulte a central de integrações para ver o motivo por conector.`,
    };
  }
  if (queue.failuresLast24h > RECENT_FAILURE_BUDGET) {
    return {
      severity: "degradado",
      detail: `${queue.failuresLast24h} falhas de execução nas últimas ${RECENT_WINDOW_HOURS} horas, acima do esperado para retentativas normais.`,
    };
  }
  if (webhooks.deadLetter > 0) {
    return {
      severity: "degradado",
      detail: `${webhooks.deadLetter} ${webhooks.deadLetter === 1 ? "entrega de webhook esgotou" : "entregas de webhook esgotaram"} as tentativas.`,
    };
  }
  if (connectors.overdue > 0) {
    return {
      severity: "atencao",
      detail: `${connectors.overdue} ${connectors.overdue === 1 ? "conector está" : "conectores estão"} com sincronização atrasada em relação ao horário previsto.`,
    };
  }
  if (webhooks.failed > 0 || queue.pending > 0) {
    return {
      severity: "atencao",
      detail: `Fila em andamento: ${queue.pending} ${queue.pending === 1 ? "execução pendente" : "execuções pendentes"} e ${webhooks.failed} ${webhooks.failed === 1 ? "entrega aguardando retentativa" : "entregas aguardando retentativa"}.`,
    };
  }
  return { severity: "saudavel", detail: "Fila de integrações, conectores e entregas sem pendência." };
}

let cached: { at: number; report: OperationalHealth } | null = null;

/** Descarta o resultado memorizado. Existe para o teste não depender de relógio. */
export function resetOperationalHealthCache() {
  cached = null;
}

/**
 * Lê os contadores de um tenant. Cada workspace usa uma conexão com o tenant
 * preso à instância — a fila tem FORCE RLS e não existe caminho de leitura
 * cruzada, nem aqui.
 */
async function readWorkspace(workspaceId: string): Promise<Counters> {
  const scoped = getScopedD1({ workspaceId, userId: null });
  const counters = emptyCounters();

  const queue = await scoped.prepare(`SELECT
      COUNT(*) FILTER (WHERE status = 'queued' AND available_at > now() - ($1 || ' minutes')::interval)::integer AS pending,
      COUNT(*) FILTER (WHERE status = 'queued' AND available_at <= now() - ($1 || ' minutes')::interval)::integer AS delayed,
      COUNT(*) FILTER (WHERE status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at < now())::integer AS stuck,
      COUNT(*) FILTER (WHERE status = 'dead_letter')::integer AS dead_letter,
      COUNT(*) FILTER (WHERE status IN ('failed', 'dead_letter') AND updated_at > now() - ($2 || ' hours')::interval)::integer AS failures_recent,
      MAX(completed_at)::text AS last_completed_at,
      MAX(completed_at) FILTER (WHERE status = 'succeeded')::text AS last_success_at,
      MAX(updated_at) FILTER (WHERE status IN ('failed', 'dead_letter'))::text AS last_failure_at
    FROM fdp_integration_jobs WHERE workspace_id = $3`)
    .bind(String(DELAYED_AFTER_MINUTES), String(RECENT_WINDOW_HOURS), workspaceId)
    .first<Record<string, unknown>>();

  counters.queue = {
    pending: Number(queue?.pending ?? 0),
    delayed: Number(queue?.delayed ?? 0),
    stuck: Number(queue?.stuck ?? 0),
    deadLetter: Number(queue?.dead_letter ?? 0),
    failuresLast24h: Number(queue?.failures_recent ?? 0),
    lastCompletedAt: (queue?.last_completed_at as string | null) ?? null,
    lastSuccessAt: (queue?.last_success_at as string | null) ?? null,
    lastFailureAt: (queue?.last_failure_at as string | null) ?? null,
  };

  const connectors = await scoped.prepare(`SELECT
      COUNT(*) FILTER (WHERE status = 'connected')::integer AS connected,
      COUNT(*) FILTER (WHERE status = 'error')::integer AS failing,
      COUNT(*) FILTER (WHERE status = 'connected' AND schedule_enabled = 1 AND next_sync_at IS NOT NULL
        AND next_sync_at <= now() - ($1 || ' minutes')::interval)::integer AS overdue,
      MAX(last_successful_sync_at)::text AS last_sync_at
    FROM fdp_integrations WHERE workspace_id = $2`)
    .bind(String(CYCLE_MINUTES), workspaceId)
    .first<Record<string, unknown>>();

  counters.connectors = {
    connected: Number(connectors?.connected ?? 0),
    failing: Number(connectors?.failing ?? 0),
    overdue: Number(connectors?.overdue ?? 0),
    lastSyncAt: (connectors?.last_sync_at as string | null) ?? null,
  };

  const webhooks = await scoped.prepare(`SELECT
      COUNT(*) FILTER (WHERE status = 'pending')::integer AS pending,
      COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed,
      COUNT(*) FILTER (WHERE status = 'dead_letter')::integer AS dead_letter,
      COUNT(*) FILTER (WHERE status = 'delivered' AND delivered_at > now() - ($1 || ' hours')::interval)::integer AS delivered_recent
    FROM fdp_webhook_deliveries WHERE workspace_id = $2`)
    .bind(String(RECENT_WINDOW_HOURS), workspaceId)
    .first<Record<string, unknown>>();

  counters.webhooks = {
    pending: Number(webhooks?.pending ?? 0),
    failed: Number(webhooks?.failed ?? 0),
    deadLetter: Number(webhooks?.dead_letter ?? 0),
    deliveredLast24h: Number(webhooks?.delivered_recent ?? 0),
  };

  return counters;
}

/** Um tenant é "com falha" quando algo nele já não está saudável. */
function workspaceIsFailing(counters: Counters) {
  return classifyOperationalHealth(counters).severity !== "saudavel";
}

export async function checkOperationalHealth(includeDetail: boolean): Promise<OperationalHealth> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return includeDetail ? cached.report : { ...cached.report, failingWorkspaces: undefined };
  }

  const total = emptyCounters();
  const failing: string[] = [];
  let scanned = 0;
  let truncated = false;

  // `fdp_workspaces` é a raiz do tenant e não tem RLS; a fila tem. Mesmo padrão
  // da varredura agendada: a lista sai daqui e cada tenant é lido com a conexão
  // presa a ele.
  const roots = getD1();
  const workspaces = await roots
    .prepare("SELECT id FROM fdp_workspaces WHERE status = 'active' ORDER BY created_at LIMIT ?")
    .bind(MAX_WORKSPACES_SCANNED + 1)
    .all<{ id: string }>();

  const rows = workspaces.results;
  if (rows.length > MAX_WORKSPACES_SCANNED) truncated = true;

  for (const workspace of rows.slice(0, MAX_WORKSPACES_SCANNED)) {
    // Um tenant ilegível não pode apagar o retrato dos demais — foi o erro que
    // deixou a varredura inteira morrer por causa de um workspace só.
    try {
      const counters = await readWorkspace(workspace.id);
      scanned += 1;
      total.queue.pending += counters.queue.pending;
      total.queue.delayed += counters.queue.delayed;
      total.queue.stuck += counters.queue.stuck;
      total.queue.deadLetter += counters.queue.deadLetter;
      total.queue.failuresLast24h += counters.queue.failuresLast24h;
      total.queue.lastCompletedAt = latest(total.queue.lastCompletedAt, counters.queue.lastCompletedAt);
      total.queue.lastSuccessAt = latest(total.queue.lastSuccessAt, counters.queue.lastSuccessAt);
      total.queue.lastFailureAt = latest(total.queue.lastFailureAt, counters.queue.lastFailureAt);
      total.connectors.connected += counters.connectors.connected;
      total.connectors.failing += counters.connectors.failing;
      total.connectors.overdue += counters.connectors.overdue;
      total.connectors.lastSyncAt = latest(total.connectors.lastSyncAt, counters.connectors.lastSyncAt);
      total.webhooks.pending += counters.webhooks.pending;
      total.webhooks.failed += counters.webhooks.failed;
      total.webhooks.deadLetter += counters.webhooks.deadLetter;
      total.webhooks.deliveredLast24h += counters.webhooks.deliveredLast24h;
      if (workspaceIsFailing(counters)) failing.push(workspace.id);
    } catch {
      // Sem detalhe do erro aqui: ele já sai no log estruturado de quem chamou,
      // e este relatório é lido por quem não deve ver stack de banco.
      failing.push(workspace.id);
    }
  }

  const { severity, detail } = classifyOperationalHealth(total);
  const report: OperationalHealth = {
    severity,
    detail: truncated ? `${detail} Retrato parcial: apenas os ${MAX_WORKSPACES_SCANNED} workspaces mais antigos foram consultados.` : detail,
    workspacesScanned: scanned,
    truncated,
    queue: total.queue,
    connectors: total.connectors,
    webhooks: total.webhooks,
    failingWorkspaces: failing,
  };

  cached = { at: Date.now(), report };
  return includeDetail ? report : { ...report, failingWorkspaces: undefined };
}

export const OPERATIONAL_HEALTH_THRESHOLDS = {
  CYCLE_MINUTES,
  DELAYED_AFTER_MINUTES,
  STALLED_AFTER_MINUTES,
  RECENT_WINDOW_HOURS,
  RECENT_FAILURE_BUDGET,
  MAX_WORKSPACES_SCANNED,
} as const;
