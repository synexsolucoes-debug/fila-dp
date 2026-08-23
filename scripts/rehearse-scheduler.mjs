/**
 * Ensaio do agendador de agentes contra PostgreSQL real (§63, §64, §89).
 *
 * O agendador é o lugar em que um erro fica invisível por semanas: ninguém
 * percebe que um agente parou de rodar, só que "o dado está velho". E os modos
 * de falhar dele são todos de concorrência — dois runners na mesma janela, uma
 * reserva que vence no meio do trabalho, uma retentativa que vira segunda
 * execução. Nada disso aparece em teste sequencial.
 *
 * Por isso este ensaio abre conexões de verdade e dispara em paralelo. Ele
 * cobre os oito casos que a §63 e a §64 pedem:
 *
 *   1. dois runners disputando o mesmo job;
 *   2. duas varreduras enfileirando o mesmo agente na mesma janela;
 *   3. um segundo job para o conector que já tem execução ativa;
 *   4. reserva vencida devolvendo o trabalho a quem o pegar depois;
 *   5. renovação de reserva por quem a detém — e a recusa a quem a perdeu;
 *   6. espera crescente e marcação de degradado depois de falhas seguidas;
 *   7. sucesso zerando a contagem;
 *   8. dead-letter esperando decisão humana, e o reprocessamento devolvendo-o.
 *
 * Uso:
 *   DATABASE_URL=postgres://... node scripts/rehearse-scheduler.mjs
 */
const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.NEON_DATABASE_URL;
if (!databaseUrl?.startsWith("postgres")) {
  throw new Error("Defina DATABASE_URL com uma conexão PostgreSQL com as migrations aplicadas.");
}

const { Pool } = await import("pg");
const pool = new Pool({ connectionString: databaseUrl, max: 8 });

const suffix = Math.random().toString(36).slice(2, 10);
const id = (prefix) => `${prefix}-${suffix}`;
const results = [];

function check(nome, condicao, detalhe = "") {
  results.push({ nome, ok: Boolean(condicao), detalhe });
  console.log(`${condicao ? "OK  " : "FALHA"}  ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
}

async function query(text, values = []) {
  const client = await pool.connect();
  try {
    return await client.query(text, values);
  } finally {
    client.release();
  }
}

/** Duas conexões distintas, disparadas sem `await` entre elas. */
async function inParallel(taskA, taskB) {
  const [a, b] = await Promise.allSettled([taskA(), taskB()]);
  return {
    a: a.status === "fulfilled" ? a.value : { error: a.reason },
    b: b.status === "fulfilled" ? b.value : { error: b.reason },
  };
}

async function setup() {
  await query(`INSERT INTO fdp_users (id, email, name) VALUES ($1, $2, 'Ensaio')
    ON CONFLICT (id) DO NOTHING`, [id("u"), `${id("u")}@ensaio.local`]);
  await query(`INSERT INTO fdp_workspaces (id, name, slug, owner_user_id) VALUES ($1, 'Ensaio', $2, $3)
    ON CONFLICT (id) DO NOTHING`, [id("w"), id("slug"), id("u")]);
  await query(`INSERT INTO fdp_workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')
    ON CONFLICT DO NOTHING`, [id("w"), id("u")]);
  await query(`INSERT INTO fdp_integrations
      (id, workspace_id, channel, display_name, status, schedule_enabled, schedule_cadence, next_sync_at)
    VALUES ($1, $2, 'tangerino', 'Tangerino', 'connected', 1, 'every_30_minutes', now() - interval '1 hour')
    ON CONFLICT (id) DO NOTHING`, [id("int"), id("w")]);
}

async function cleanup() {
  await query("DELETE FROM fdp_workspaces WHERE id = $1", [id("w")]).catch(() => undefined);
  await query("DELETE FROM fdp_users WHERE id = $1", [id("u")]).catch(() => undefined);
}

/** Cria uma execução e o job dela, do jeito que o produto cria. */
async function queueRun(key, { status = "queued", attempt = 0, maxAttempts = 3, availableAt = "now()" } = {}) {
  const runId = `${id("run")}-${key}`;
  const jobId = `${id("job")}-${key}`;
  await query(`INSERT INTO fdp_integration_sync_runs
      (id, workspace_id, integration_id, trigger_type, status, idempotency_key)
    VALUES ($1, $2, $3, 'scheduled', 'queued', $4)
    ON CONFLICT (workspace_id, integration_id, idempotency_key) DO NOTHING`,
  [runId, id("w"), id("int"), key]);
  await query(`INSERT INTO fdp_integration_jobs
      (id, workspace_id, integration_id, run_id, idempotency_key, status, attempt, max_attempts, available_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${availableAt})`,
  [jobId, id("w"), id("int"), runId, `run:${runId}`, status, attempt, maxAttempts]);
  return { runId, jobId };
}

/** A consulta de reserva do produto, palavra por palavra. */
function claim(token) {
  return query(`WITH candidate AS (
      SELECT job.id FROM fdp_integration_jobs job
      WHERE job.workspace_id = $1 AND job.status IN ('queued', 'leased') AND job.available_at <= CURRENT_TIMESTAMP
        AND (job.status = 'queued' OR job.lease_expires_at < CURRENT_TIMESTAMP)
      ORDER BY job.available_at, job.created_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE fdp_integration_jobs job SET status = 'leased', lease_token = $2,
      lease_expires_at = CURRENT_TIMESTAMP + make_interval(mins => 2),
      attempt = job.attempt + 1, updated_at = CURRENT_TIMESTAMP FROM candidate WHERE job.id = candidate.id
    RETURNING job.id, job.attempt, job.lease_token`, [id("w"), token]);
}

/* 1. Dois runners disputando o mesmo job. */
async function twoRunners() {
  await queueRun("janela-1");
  const { a, b } = await inParallel(() => claim("runner-a"), () => claim("runner-b"));
  const reservados = [a, b].filter((result) => result.rowCount === 1).length;
  check("dois runners disputam o mesmo job: um só reserva", reservados === 1, `${reservados} reserva(s)`);

  const row = await query("SELECT status, attempt FROM fdp_integration_jobs WHERE workspace_id = $1 AND run_id = $2",
    [id("w"), `${id("run")}-janela-1`]);
  check("a tentativa foi contada uma vez, e não duas",
    Number(row.rows[0].attempt) === 1, `tentativa ${row.rows[0].attempt}`);
}

/* 2. O segundo job para um conector que já tem execução ativa. */
async function secondActiveJob() {
  /* Inserido direto, e não pelo caminho do produto: o que se quer provar aqui é
     que o **banco** recusa, e não que a aplicação evita. Se a garantia
     dependesse só da condição na consulta, a próxima rota escrita a esqueceria. */
  let violou = "";
  try {
    await query(`INSERT INTO fdp_integration_jobs
        (id, workspace_id, integration_id, run_id, idempotency_key, status)
      VALUES ($1, $2, $3, $4, $5, 'queued')`,
    [`${id("job")}-extra`, id("w"), id("int"), `${id("run")}-janela-1`, "run:extra"]);
  } catch (error) {
    violou = String(error?.constraint ?? error?.message ?? "");
  }
  check("o banco recusa dois jobs ativos para o mesmo conector (§31)",
    violou.includes("fdp_integration_jobs_active_uq"),
    violou || "o segundo job foi aceito");
}

/* 3. Duas varreduras na mesma janela. */
async function twoSweeps() {
  /* A execução anterior é encerrada primeiro porque o produto já impõe uma
     execução ativa por conector: sem isso o ensaio mediria aquela invariante, e
     não a idempotência da janela, que é o que interessa aqui. */
  await query("UPDATE fdp_integration_sync_runs SET status = 'succeeded' WHERE workspace_id = $1 AND id = $2",
    [id("w"), `${id("run")}-janela-1`]);

  const key = `agent:tangerino:${new Date(Math.floor(Date.now() / 1_800_000) * 1_800_000).toISOString()}`;
  const insert = () => query(`INSERT INTO fdp_integration_sync_runs
      (id, workspace_id, integration_id, trigger_type, status, idempotency_key)
    VALUES ($1, $2, $3, 'scheduled', 'queued', $4)
    ON CONFLICT (workspace_id, integration_id, idempotency_key) DO NOTHING RETURNING id`,
  [`${id("run")}-${Math.random().toString(36).slice(2)}`, id("w"), id("int"), key]);

  await inParallel(insert, insert);
  const total = await query(`SELECT count(*)::int AS total FROM fdp_integration_sync_runs
    WHERE workspace_id = $1 AND integration_id = $2 AND idempotency_key = $3`, [id("w"), id("int"), key]);
  check("duas varreduras na mesma janela criam uma execução só",
    Number(total.rows[0].total) === 1, `${total.rows[0].total} execução(ões)`);
}

/* 4. Reserva vencida devolve o trabalho. */
async function expiredLease() {
  await query(`UPDATE fdp_integration_jobs
      SET lease_expires_at = CURRENT_TIMESTAMP - make_interval(mins => 5)
    WHERE workspace_id = $1 AND run_id = $2`, [id("w"), `${id("run")}-janela-1`]);

  const retomado = await claim("runner-c");
  check("reserva vencida volta para quem pegar depois (§32)", retomado.rowCount === 1,
    retomado.rowCount === 1 ? `tentativa ${retomado.rows[0].attempt}` : "o job ficou preso");
  check("a segunda tentativa foi contada", Number(retomado.rows[0]?.attempt ?? 0) === 2,
    `tentativa ${retomado.rows[0]?.attempt}`);
}

/* 5. Heartbeat: só quem detém a reserva a renova. */
async function heartbeat() {
  const renew = (token) => query(`UPDATE fdp_integration_jobs
      SET lease_expires_at = CURRENT_TIMESTAMP + make_interval(mins => 20), updated_at = CURRENT_TIMESTAMP
    WHERE workspace_id = $1 AND id = $2 AND lease_token = $3 AND status = 'leased' RETURNING id`,
  [id("w"), `${id("job")}-janela-1`, token]);

  const dono = await renew("runner-c");
  const alheio = await renew("runner-a");
  check("quem detém a reserva consegue renová-la", dono.rowCount === 1);
  check("quem perdeu a reserva não a estende de volta", alheio.rowCount === 0,
    alheio.rowCount === 0 ? "escrita recusada" : "um worker atrasado reescreveu por cima de quem assumiu");
}

/* 6. Espera crescente e degradação. */
async function backoff() {
  const fail = () => query(`UPDATE fdp_integrations
      SET consecutive_failures = consecutive_failures + 1,
          degraded_since = CASE WHEN consecutive_failures + 1 >= 3 THEN COALESCE(degraded_since, CURRENT_TIMESTAMP) ELSE degraded_since END,
          next_sync_at = CURRENT_TIMESTAMP + make_interval(mins => CASE
            WHEN consecutive_failures + 1 >= 4 THEN 60
            WHEN consecutive_failures + 1 = 3 THEN 15
            WHEN consecutive_failures + 1 = 2 THEN 5
            ELSE 1 END),
          updated_at = CURRENT_TIMESTAMP
    WHERE workspace_id = $1 AND id = $2
    RETURNING consecutive_failures, degraded_since,
      EXTRACT(EPOCH FROM (next_sync_at - CURRENT_TIMESTAMP)) / 60 AS espera`, [id("w"), id("int")]);

  const esperas = [];
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const row = await fail();
    esperas.push(Math.round(Number(row.rows[0].espera)));
  }
  check("a espera cresce 1 → 5 → 15 → 60 minutos (§33)",
    JSON.stringify(esperas) === JSON.stringify([1, 5, 15, 60]), esperas.join(" → "));

  const estado = await query("SELECT consecutive_failures, degraded_since FROM fdp_integrations WHERE workspace_id = $1 AND id = $2",
    [id("w"), id("int")]);
  check("quatro falhas seguidas marcam o agente como degradado (§34)",
    estado.rows[0].degraded_since !== null, `${estado.rows[0].consecutive_failures} falha(s)`);
}

/* 7. Sucesso zera a contagem. */
async function recovery() {
  await query(`UPDATE fdp_integrations
      SET consecutive_failures = 0, degraded_since = NULL, last_successful_sync_at = CURRENT_TIMESTAMP
    WHERE workspace_id = $1 AND id = $2`, [id("w"), id("int")]);
  const row = await query("SELECT consecutive_failures, degraded_since FROM fdp_integrations WHERE workspace_id = $1 AND id = $2",
    [id("w"), id("int")]);
  check("o conector recuperado deixa de aparecer como degradado",
    Number(row.rows[0].consecutive_failures) === 0 && row.rows[0].degraded_since === null);
}

/* 8. Dead-letter espera decisão, e o reprocessamento a devolve. */
async function deadLetter() {
  await query(`UPDATE fdp_integration_jobs SET status = 'dead_letter', completed_at = CURRENT_TIMESTAMP,
      lease_token = '', lease_expires_at = NULL, last_error_message = 'Provedor indisponível'
    WHERE workspace_id = $1 AND run_id = $2`, [id("w"), `${id("run")}-janela-1`]);

  const ignorado = await claim("runner-d");
  check("execução esgotada não volta sozinha para a fila (§35)", ignorado.rowCount === 0,
    ignorado.rowCount === 0 ? "esperando decisão humana" : "o job voltou sem ninguém decidir");

  const requeue = () => query(`UPDATE fdp_integration_jobs job
      SET status = 'queued', attempt = 0, available_at = CURRENT_TIMESTAMP,
          lease_token = '', lease_expires_at = NULL, completed_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE job.workspace_id = $1 AND job.integration_id = $2 AND job.status = 'dead_letter'
      AND NOT EXISTS (
        SELECT 1 FROM fdp_integration_jobs active
        WHERE active.workspace_id = job.workspace_id AND active.integration_id = job.integration_id
          AND active.status IN ('queued', 'leased')
      ) RETURNING job.id`, [id("w"), id("int")]);

  const { a, b } = await inParallel(requeue, requeue);
  const devolvidos = [a, b].filter((result) => result.rowCount === 1).length;
  check("dois cliques em reprocessar devolvem um job só", devolvidos === 1, `${devolvidos} devolução(ões)`);

  const retomado = await claim("runner-e");
  check("o job reprocessado volta a ser reservável", retomado.rowCount === 1);
}

try {
  await setup();
  await twoRunners();
  await secondActiveJob();
  await twoSweeps();
  await expiredLease();
  await heartbeat();
  await backoff();
  await recovery();
  await deadLetter();
} finally {
  await cleanup();
  await pool.end();
}

const falhas = results.filter((result) => !result.ok);
console.log(`\nEnsaio do agendador: ${results.length - falhas.length}/${results.length} verificações aprovadas.`);
if (falhas.length) process.exitCode = 1;
