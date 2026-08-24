import { getD1, getScopedD1 } from "../db/index.ts";
import { DEGRADED_AFTER_FAILURES } from "./agent-schedule.ts";

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
/**
 * Dias que uma triagem pode esperar antes de virar sintoma.
 *
 * Três, e não um: entrada que chega na sexta e é olhada na segunda é operação
 * normal, e acender alarme nela ensina a equipe a ignorar o alarme. Depois de
 * três dias já não é "vou ver depois" — é ninguém olhando.
 */
const STALE_TRIAGE_DAYS = 3;
/**
 * Dias sem movimento até uma demanda de processo virar sintoma.
 *
 * Quinze cobre a competência inteira: uma demanda de fechamento pode
 * legitimamente esperar a virada do mês. Além disso, ela não está esperando —
 * está esquecida.
 */
const STALLED_INSTANCE_DAYS = 15;

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

/**
 * Sintomas do trabalho, e não só da fila (§52).
 *
 * A fila pode estar drenando e a operação continuar parada: um agente que
 * falhou três vezes seguidas, uma triagem que ninguém abre há uma semana, uma
 * demanda que não se move há quinze dias. Nenhum desses aparece em contagem de
 * job — e todos eles significam trabalho de cliente parado.
 */
export type OperationsHealth = {
  /** Agentes com falhas seguidas acima do limite documentado. */
  degradedAgents: number;
  /** Entradas esperando classificação humana. */
  pendingTriage: number;
  /** Triagem parada além do tolerável: ninguém está olhando. */
  staleTriage: number;
  /** Demandas com processo que não se movem há muito tempo. */
  stalledInstances: number;
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
  operations: OperationsHealth;
  /** Falhas por tenant, só para quem administra a plataforma. */
  failingWorkspaces?: string[];
};

type Counters = {
  queue: QueueHealth; connectors: ConnectorHealth; webhooks: WebhookHealth; operations: OperationsHealth;
};

const emptyCounters = (): Counters => ({
  queue: { pending: 0, delayed: 0, stuck: 0, deadLetter: 0, failuresLast24h: 0, lastCompletedAt: null, lastSuccessAt: null, lastFailureAt: null },
  connectors: { connected: 0, failing: 0, overdue: 0, lastSyncAt: null },
  webhooks: { pending: 0, failed: 0, deadLetter: 0, deliveredLast24h: 0 },
  operations: { degradedAgents: 0, pendingTriage: 0, staleTriage: 0, stalledInstances: 0 },
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
  const { queue, connectors, webhooks, operations } = counters;

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
  if (operations.degradedAgents > 0) {
    return {
      severity: "degradado",
      detail: `${operations.degradedAgents} ${operations.degradedAgents === 1 ? "agente acumulou" : "agentes acumularam"} ${DEGRADED_AFTER_FAILURES} falhas seguidas. Eles continuam tentando, com espera crescente, mas o dado que trazem pode estar desatualizado.`,
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
  if (operations.staleTriage > 0) {
    return {
      severity: "atencao",
      detail: `${operations.staleTriage} ${operations.staleTriage === 1 ? "entrada aguarda" : "entradas aguardam"} classificação há mais de ${STALE_TRIAGE_DAYS} dias. Ninguém está abrindo a triagem.`,
    };
  }
  if (operations.stalledInstances > 0) {
    return {
      severity: "atencao",
      detail: `${operations.stalledInstances} ${operations.stalledInstances === 1 ? "demanda de processo não se move" : "demandas de processo não se movem"} há mais de ${STALLED_INSTANCE_DAYS} dias.`,
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
  if (operations.pendingTriage > 0) {
    return {
      severity: "atencao",
      detail: `${operations.pendingTriage} ${operations.pendingTriage === 1 ? "entrada aguarda" : "entradas aguardam"} classificação na triagem.`,
    };
  }
  return { severity: "saudavel", detail: "Fila, conectores, entregas e trabalho operacional sem pendência." };
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

  /* Sintomas do trabalho (§52). Uma consulta só: a saúde é lida por monitor
     externo em intervalo curto, e três consultas por tenant multiplicariam o
     custo pelo número de clientes. */
  const operations = await scoped.prepare(`SELECT
      (SELECT COUNT(*) FROM fdp_integrations i
        WHERE i.workspace_id = $3 AND i.consecutive_failures >= $1)::integer AS degraded_agents,
      (SELECT COUNT(*) FROM fdp_agent_proposals p
        WHERE p.workspace_id = $3 AND p.status = 'pending_triage')::integer AS pending_triage,
      (SELECT COUNT(*) FROM fdp_agent_proposals p
        WHERE p.workspace_id = $3 AND p.status = 'pending_triage'
          AND p.created_at < now() - ($2 || ' days')::interval)::integer AS stale_triage,
      (SELECT COUNT(*) FROM fdp_cards c
        WHERE c.workspace_id = $3 AND c.archived = 0 AND c.closed_at IS NULL
          AND COALESCE(c.process_definition_id, '') <> ''
          AND c.updated_at < now() - ($4 || ' days')::interval)::integer AS stalled_instances`)
    .bind(String(DEGRADED_AFTER_FAILURES), String(STALE_TRIAGE_DAYS), workspaceId, String(STALLED_INSTANCE_DAYS))
    .first<Record<string, unknown>>();

  counters.operations = {
    degradedAgents: Number(operations?.degraded_agents ?? 0),
    pendingTriage: Number(operations?.pending_triage ?? 0),
    staleTriage: Number(operations?.stale_triage ?? 0),
    stalledInstances: Number(operations?.stalled_instances ?? 0),
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
      total.operations.degradedAgents += counters.operations.degradedAgents;
      total.operations.pendingTriage += counters.operations.pendingTriage;
      total.operations.staleTriage += counters.operations.staleTriage;
      total.operations.stalledInstances += counters.operations.stalledInstances;
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
    operations: total.operations,
    failingWorkspaces: failing,
  };

  cached = { at: Date.now(), report };
  return includeDetail ? report : { ...report, failingWorkspaces: undefined };
}

export const OPERATIONAL_HEALTH_THRESHOLDS = {
  STALE_TRIAGE_DAYS,
  STALLED_INSTANCE_DAYS,
  DEGRADED_AFTER_FAILURES,
  CYCLE_MINUTES,
  DELAYED_AFTER_MINUTES,
  STALLED_AFTER_MINUTES,
  RECENT_WINDOW_HOURS,
  RECENT_FAILURE_BUDGET,
  MAX_WORKSPACES_SCANNED,
} as const;
