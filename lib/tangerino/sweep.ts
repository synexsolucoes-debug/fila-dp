import type { getD1 } from "../../db/index.ts";
import { tangerinoAgentConfig } from "./config.ts";

type Database = ReturnType<typeof getD1>;

/**
 * A varredura periódica do Agente Tangerino: admissões pendentes de conferência.
 *
 * Até aqui a consulta só partia da ficha do colaborador, uma a uma. Quem
 * acompanha admissão precisava lembrar de abrir cada ficha e clicar — e a
 * situação na origem muda sozinha, sem avisar ninguém. A varredura tira essa
 * lembrança do caminho.
 *
 * ## O que conta como "pendente de conferência"
 *
 * Um colaborador entra na varredura quando as quatro coisas valem ao mesmo
 * tempo:
 *
 *   1. tem vínculo com o Tangerino (`fdp_employee_external_refs`) — sem
 *      identificador na origem não há o que consultar, e enfileirar mesmo assim
 *      gastaria navegador para descobrir isso lá dentro;
 *   2. a última consulta bem-sucedida **não** terminou em `COMPLETED` nem
 *      `CANCELLED` — esses dois são desfecho, e reconsultar um desfecho é
 *      trabalho que não muda nada;
 *   3. não há consulta em curso para ele;
 *   4. a última leitura já passou da validade configurada.
 *
 * Quem nunca foi consultado entra pelo item 2 por ausência: não há desfecho,
 * então há o que conferir.
 *
 * ## Por que a varredura tem teto
 *
 * Cada item vira uma sessão de navegador contra o Tangerino. Uma varredura sem
 * limite, num grupo com muitos vínculos, viraria uma enxurrada de sessões
 * simultâneas contra o sistema de outra empresa — que é o jeito de fazer o
 * cliente ser bloqueado por lá. O teto é por execução; o que sobra é lido no
 * ciclo seguinte, e é isso que a cadência existe para permitir.
 *
 * ## O que ela não faz
 *
 * Não altera colaborador, não decide nada e não escreve na origem. Ela só
 * **enfileira leitura**. O que a leitura descobre segue o caminho de sempre:
 * evento, e proposta quando há dúvida.
 */

/** Desfechos que encerram a conferência: reconsultá-los não muda nada. */
export const TERMINAL_ADMISSION_STATUSES = ["COMPLETED", "CANCELLED"] as const;

/** Teto de itens por execução, para a varredura não virar enxurrada de sessões. */
export const SWEEP_BATCH_LIMIT = 25;

export type SweepCandidate = {
  employeeId: string;
  companyId: string;
  externalAdmissionId: string;
  registrationNumber: string;
  fullName: string;
};

/**
 * Os colaboradores que a próxima execução deve consultar.
 *
 * `DISTINCT ON` com a consulta mais recente por colaborador, e não um
 * `EXISTS` por status: o que decide é **a última** leitura, não a existência de
 * alguma leitura com aquele status. Um colaborador que já esteve `COMPLETED` e
 * voltou a `WAITING_DOCUMENTS` precisa reentrar na fila, e um `EXISTS` o
 * deixaria de fora para sempre.
 */
export function prepareSweepCandidates(d1: Database, workspaceId: string, limit = SWEEP_BATCH_LIMIT) {
  const config = tangerinoAgentConfig();
  return d1.prepare(`
    WITH ultima AS (
      SELECT DISTINCT ON (c.employee_id)
             c.employee_id, c.normalized_status, c.consulted_at
        FROM fdp_tangerino_admission_consultations c
       WHERE c.workspace_id = ? AND c.state = 'SUCCESS'
       ORDER BY c.employee_id, c.consulted_at DESC
    )
    SELECT employee.id AS employee_id, employee.company_id, employee.registration_number,
           employee.full_name, reference.external_id AS external_admission_id
      FROM fdp_employees employee
      JOIN fdp_employee_external_refs reference
        ON reference.workspace_id = employee.workspace_id
       AND reference.employee_id = employee.id
       AND reference.source = 'tangerino'
       AND reference.external_id <> ''
      LEFT JOIN ultima ON ultima.employee_id = employee.id
     WHERE employee.workspace_id = ?
       AND employee.termination_date IS NULL
       -- Desfecho não se reconsulta.
       AND (ultima.normalized_status IS NULL
            OR ultima.normalized_status NOT IN ('COMPLETED', 'CANCELLED'))
       -- Leitura ainda fresca não se repete: a validade é a mesma que a
       -- consulta manual respeita, para os dois caminhos não discordarem.
       AND (ultima.consulted_at IS NULL
            OR ultima.consulted_at <= CURRENT_TIMESTAMP - make_interval(secs => ?))
       -- Já há uma consulta em curso para este colaborador.
       AND NOT EXISTS (
         SELECT 1 FROM fdp_tangerino_admission_consultations ativa
          WHERE ativa.workspace_id = employee.workspace_id
            AND ativa.employee_id = employee.id
            AND ativa.state IN ('QUEUED', 'RUNNING'))
     -- Quem está sem leitura há mais tempo vai primeiro: sob teto, a ordem
     -- decide quem espera outro ciclo, e deixar o mais antigo para depois é
     -- como um colaborador fica sem conferência indefinidamente.
     ORDER BY ultima.consulted_at ASC NULLS FIRST, employee.created_at ASC
     LIMIT ?`)
    .bind(workspaceId, workspaceId, config.cacheTtlSeconds, Math.max(1, Math.min(limit, SWEEP_BATCH_LIMIT)));
}

/**
 * Enfileira uma consulta de varredura.
 *
 * Sem `requested_by_user_id`: não houve pessoa. O limite por pessoa que a
 * consulta manual aplica não cabe aqui — quem limita a varredura é o teto do
 * lote e a cadência —, e atribuí-la a alguém faria a auditoria dizer que
 * um operador pediu o que a máquina decidiu sozinha.
 *
 * O `ON CONFLICT DO NOTHING` sobre o índice parcial de consulta ativa é a
 * garantia de verdade: duas varreduras concorrentes no mesmo workspace não
 * produzem duas consultas para o mesmo colaborador.
 */
export function prepareSweepConsultation(d1: Database, input: {
  workspaceId: string;
  integrationId: string;
  candidate: SweepCandidate;
}) {
  return d1.prepare(`INSERT INTO fdp_tangerino_admission_consultations
      (id, workspace_id, company_id, employee_id, integration_id, requested_by_user_id, state, external_admission_id)
    VALUES (?, ?, ?, ?, ?, NULL, 'QUEUED', ?)
    ON CONFLICT DO NOTHING
    RETURNING id`)
    .bind(crypto.randomUUID(), input.workspaceId, input.candidate.companyId,
      input.candidate.employeeId, input.integrationId, input.candidate.externalAdmissionId);
}

export function toSweepCandidate(row: Record<string, unknown>): SweepCandidate {
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    employeeId: text(row.employee_id),
    companyId: text(row.company_id),
    externalAdmissionId: text(row.external_admission_id),
    registrationNumber: text(row.registration_number),
    fullName: text(row.full_name),
  };
}
