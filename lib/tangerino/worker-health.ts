/**
 * Saúde do worker do Windows, separada da saúde do agendamento.
 *
 * ## A pergunta que o painel não respondia
 *
 * Ele dizia se o agente estava **habilitado** — uma linha de configuração. Não
 * dizia se o processo do Windows está de pé, quando ele falou pela última vez,
 * se tem fila esperando, nem se parou porque apareceu um CAPTCHA.
 *
 * A diferença importa porque as causas são opostas e o remédio também:
 *
 *   * worker mudo, fila cheia → o computador está desligado, suspenso, sem rede
 *     ou a sessão do Windows caiu. Quem resolve é quem está perto da máquina.
 *   * worker vivo, fila vazia, agendamento parado → o processo está bem e o
 *     backend não está enfileirando. Quem resolve é quem cuida do servidor.
 *   * worker vivo pedindo autenticação → o navegador está esperando uma pessoa.
 *
 * Tratar os três como "agente com problema" mandaria o operador procurar no
 * lugar errado em dois dos três casos.
 *
 * ## Por que o batimento é gravado pelo worker, e não inferido
 *
 * Inferir vida a partir do último trabalho concluído confunde "está parado" com
 * "não tinha o que fazer". Um worker saudável num dia sem admissões ficaria
 * indistinguível de um worker morto — e o alarme apareceria justamente quando
 * não há problema nenhum.
 */
import type { getD1 } from "../../db/index.ts";

type Database = ReturnType<typeof getD1>;

/** Depois disso o worker é considerado mudo. Três ciclos de varredura. */
export const HEARTBEAT_STALE_SECONDS = 180;

export type WorkerHeartbeat = {
  workerId: string;
  workerVersion: string;
  startedAt: string;
  lastSeenAt: string;
  lastConsultationAt: string | null;
  pendingConsultations: number;
  pendingAttachments: number;
  needsAuthentication: boolean;
  lastErrorCode: string;
};

export type WorkerAvailability = "online" | "stale" | "never_seen" | "needs_authentication";

export type WorkerHealth = {
  availability: WorkerAvailability;
  heartbeat: WorkerHeartbeat | null;
  secondsSinceLastSeen: number | null;
  /** Fila esperando o worker. Cheia com worker mudo é o sintoma que importa. */
  pendingConsultations: number;
  pendingAttachments: number;
  /** O que a pessoa deve fazer, em uma frase. */
  detail: string;
};

const text = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
};

/**
 * Grava o batimento. Um `worker_id` por processo; reiniciar reaproveita a linha.
 *
 * Escrito direto no banco, e não por rota HTTP: o worker do Windows já tem
 * `DATABASE_URL` e é assim que ele drena a própria fila. Uma rota só para o
 * batimento seria superfície autenticada a mais para dizer o que o processo já
 * pode gravar sozinho.
 */
export function prepareWorkerHeartbeat(d1: Database, input: {
  workspaceId: string;
  integrationId: string;
  workerId: string;
  workerVersion: string;
  pendingConsultations: number;
  pendingAttachments: number;
  lastConsultationAt: string | null;
  needsAuthentication: boolean;
  lastErrorCode: string;
}) {
  return d1.prepare(`INSERT INTO fdp_tangerino_worker_heartbeats
      (id, workspace_id, integration_id, worker_id, worker_version, pending_consultations,
       pending_attachments, last_consultation_at, needs_authentication, last_error_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (workspace_id, worker_id) DO UPDATE SET
      integration_id = EXCLUDED.integration_id,
      worker_version = EXCLUDED.worker_version,
      pending_consultations = EXCLUDED.pending_consultations,
      pending_attachments = EXCLUDED.pending_attachments,
      -- A data da ultima consulta so avanca: um batimento sem consulta nova nao
      -- pode apagar a memoria de quando a ultima aconteceu.
      last_consultation_at = GREATEST(
        fdp_tangerino_worker_heartbeats.last_consultation_at, EXCLUDED.last_consultation_at),
      needs_authentication = EXCLUDED.needs_authentication,
      last_error_code = EXCLUDED.last_error_code,
      last_seen_at = CURRENT_TIMESTAMP`)
    .bind(crypto.randomUUID(), input.workspaceId, input.integrationId, input.workerId.slice(0, 120),
      input.workerVersion.slice(0, 40), count(input.pendingConsultations), count(input.pendingAttachments),
      input.lastConsultationAt, input.needsAuthentication ? 1 : 0, input.lastErrorCode.slice(0, 120));
}

/** O batimento mais recente do grupo, com a fila que ele enxerga. */
export async function readWorkerHealth(d1: Database, workspaceId: string, now = new Date()): Promise<WorkerHealth> {
  const row = await d1.prepare(`SELECT worker_id, worker_version, started_at::text AS started_at,
      last_seen_at::text AS last_seen_at, last_consultation_at::text AS last_consultation_at,
      pending_consultations, pending_attachments, needs_authentication, last_error_code
    FROM fdp_tangerino_worker_heartbeats
    WHERE workspace_id = ? ORDER BY last_seen_at DESC LIMIT 1`)
    .bind(workspaceId).first<Record<string, unknown>>();

  /* A fila é contada aqui, e não só no batimento: o worker mudo não atualiza
     nada, e é exatamente nele que saber o tamanho da fila importa. */
  const queue = await d1.prepare(`SELECT
      (SELECT COUNT(*) FROM fdp_tangerino_admission_consultations
        WHERE workspace_id = ? AND state IN ('QUEUED', 'RUNNING')) AS consultations,
      (SELECT COUNT(*) FROM fdp_tangerino_attachment_authorizations
        WHERE workspace_id = ? AND state IN ('QUEUED', 'RUNNING')) AS attachments`)
    .bind(workspaceId, workspaceId).first<{ consultations: unknown; attachments: unknown }>();

  const pendingConsultations = count(queue?.consultations);
  const pendingAttachments = count(queue?.attachments);
  const pending = pendingConsultations + pendingAttachments;

  if (!row) {
    return {
      availability: "never_seen", heartbeat: null, secondsSinceLastSeen: null,
      pendingConsultations, pendingAttachments,
      detail: pending > 0
        ? `O worker nunca se comunicou e há ${pending} ${pending === 1 ? "tarefa esperando" : "tarefas esperando"}. Confira se ele está instalado e em execução no computador do DP.`
        : "O worker ainda não se comunicou. Ele precisa estar em execução no computador do DP para consultar admissões.",
    };
  }

  const heartbeat: WorkerHeartbeat = {
    workerId: text(row.worker_id),
    workerVersion: text(row.worker_version),
    startedAt: text(row.started_at),
    lastSeenAt: text(row.last_seen_at),
    lastConsultationAt: text(row.last_consultation_at) || null,
    pendingConsultations: count(row.pending_consultations),
    pendingAttachments: count(row.pending_attachments),
    needsAuthentication: Number(row.needs_authentication) === 1,
    lastErrorCode: text(row.last_error_code),
  };

  const seenAt = new Date(heartbeat.lastSeenAt);
  const secondsSinceLastSeen = Number.isNaN(seenAt.getTime())
    ? null
    : Math.max(0, Math.round((now.getTime() - seenAt.getTime()) / 1000));
  const stale = secondsSinceLastSeen === null || secondsSinceLastSeen > HEARTBEAT_STALE_SECONDS;

  if (stale) {
    return {
      availability: "stale", heartbeat, secondsSinceLastSeen, pendingConsultations, pendingAttachments,
      detail: `O worker não se comunica há ${secondsSinceLastSeen === null ? "um tempo indeterminado" : describeSeconds(secondsSinceLastSeen)}. `
        + "O computador pode estar desligado, suspenso ou sem rede. Enquanto isso, nenhuma admissão é consultada.",
    };
  }
  if (heartbeat.needsAuthentication) {
    return {
      availability: "needs_authentication", heartbeat, secondsSinceLastSeen, pendingConsultations, pendingAttachments,
      detail: "O worker está de pé e parou esperando autenticação na Sólides — CAPTCHA, verificação em duas etapas ou senha recusada. "
        + "Abra a janela do navegador no computador do DP e conclua o acesso.",
    };
  }
  return {
    availability: "online", heartbeat, secondsSinceLastSeen, pendingConsultations, pendingAttachments,
    detail: pending > 0
      ? `O worker está ativo e tem ${pending} ${pending === 1 ? "tarefa na fila" : "tarefas na fila"}.`
      : "O worker está ativo e sem tarefas na fila.",
  };
}

function describeSeconds(seconds: number) {
  if (seconds < 120) return `${seconds} segundos`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes} minutos`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} horas` : `${Math.round(hours / 24)} dias`;
}

/**
 * Saúde do agendamento, que é outra coisa.
 *
 * Um worker perfeito não recebe tarefa nenhuma se o cron do backend parou. Esta
 * leitura responde "o servidor está enfileirando?", e é o que impede o painel de
 * culpar o computador do operador por uma falha que não é dele.
 */
export async function readScheduleHealth(d1: Database, workspaceId: string, now = new Date()) {
  const row = await d1.prepare(`SELECT status, schedule_cadence, schedule_enabled,
      next_sync_at::text AS next_sync_at, last_sync_at::text AS last_sync_at
    FROM fdp_integrations WHERE workspace_id = ? AND channel = 'tangerino_browser'`)
    .bind(workspaceId).first<Record<string, unknown>>();
  if (!row) {
    return {
      configured: false, scheduleEnabled: false, overdue: false,
      nextRunAt: null, lastRunAt: null, detail: "O agente não está configurado neste grupo.",
    };
  }

  const nextRunAt = text(row.next_sync_at) || null;
  const scheduled = nextRunAt ? new Date(nextRunAt) : null;
  /* Uma hora de atraso sobre o horário previsto: mais do que qualquer cadência
     oferecida, e menos do que o tempo em que alguém notaria sozinho. */
  const overdue = Boolean(scheduled && !Number.isNaN(scheduled.getTime())
    && now.getTime() - scheduled.getTime() > 60 * 60 * 1000);
  /* Agendamento desligado não é atraso: alguém o desligou de propósito, e
     chamar isso de falha mandaria o operador procurar defeito numa decisão. */
  const scheduleEnabled = Number(row.schedule_enabled ?? 1) === 1;
  return {
    configured: true,
    scheduleEnabled,
    overdue: overdue && scheduleEnabled,
    nextRunAt,
    lastRunAt: text(row.last_sync_at) || null,
    detail: !scheduleEnabled
      ? "A varredura automática está desligada para este agente. Só as execuções manuais enfileiram admissões."
      : overdue
      ? "A varredura do servidor está atrasada. O worker pode estar bem e mesmo assim não receber tarefas — confira o agendamento do backend."
      : "O agendamento do servidor está em dia.",
  };
}
