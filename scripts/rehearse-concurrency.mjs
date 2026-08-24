/**
 * Ensaio de concorrência contra PostgreSQL real (§35).
 *
 * O ponto do §35 é direto: **idempotência comprovada por teste sequencial não é
 * idempotência comprovada**. Chamar a mesma função duas vezes em sequência
 * passa por qualquer verificação em código; o que quebra em produção são duas
 * conexões chegando ao mesmo tempo, cada uma vendo o estado anterior à outra.
 *
 * Por isso este ensaio abre conexões de verdade e dispara em paralelo. Ele
 * cobre os cinco casos que o produto tem:
 *
 *   1. duas pessoas editando a mesma demanda;
 *   2. dois webhooks idênticos simultâneos;
 *   3. dois trabalhadores tentando pegar o mesmo trabalho;
 *   4. duas aprovações simultâneas;
 *   5. duas requisições de fechamento simultâneas.
 *
 * Em todos, o resultado esperado é o mesmo: **um vence, um é recusado**, e o
 * recusado sabe que perdeu — em vez de sobrescrever em silêncio.
 *
 * Uso:
 *   DATABASE_URL=postgres://... node --experimental-strip-types scripts/rehearse-concurrency.mjs
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
  await query(`INSERT INTO fdp_boards (id, workspace_id, name, board_type) VALUES ($1, $2, 'Quadro', 'operational')
    ON CONFLICT (id) DO NOTHING`, [id("b"), id("w")]);
  await query(`INSERT INTO fdp_lists (id, workspace_id, board_id, name, kind, position)
    VALUES ($1, $2, $3, 'Novas', 'new', 1000) ON CONFLICT (id) DO NOTHING`, [id("l"), id("w"), id("b")]);
  await query(`INSERT INTO fdp_cards (id, workspace_id, board_id, list_id, title, position, created_by)
    VALUES ($1, $2, $3, $4, 'Demanda do ensaio', 1000, 'ensaio@local') ON CONFLICT (id) DO NOTHING`,
  [id("card"), id("w"), id("b"), id("l")]);
  await query(`INSERT INTO fdp_integrations (id, workspace_id, channel, display_name, status)
    VALUES ($1, $2, 'teams', 'Teams', 'connected') ON CONFLICT (id) DO NOTHING`, [id("int"), id("w")]);
}

async function cleanup() {
  // Ordem inversa da criação; o resto cai por cascata do workspace.
  await query("DELETE FROM fdp_workspaces WHERE id = $1", [id("w")]).catch(() => undefined);
  await query("DELETE FROM fdp_users WHERE id = $1", [id("u")]).catch(() => undefined);
}

/* 1. Duas pessoas editando a mesma demanda. */
async function twoEditors() {
  const row = await query("SELECT version FROM fdp_cards WHERE workspace_id = $1 AND id = $2", [id("w"), id("card")]);
  const seen = Number(row.rows[0].version);

  const update = (titulo) => query(
    `UPDATE fdp_cards SET title = $1, updated_at = now()
      WHERE workspace_id = $2 AND id = $3 AND version = $4 RETURNING version`,
    [titulo, id("w"), id("card"), seen],
  );
  const { a, b } = await inParallel(() => update("Título da pessoa A"), () => update("Título da pessoa B"));
  const applied = [a, b].filter((result) => result.rowCount === 1).length;
  check("demanda: duas edições concorrentes, uma vence", applied === 1, `${applied} escrita(s) aplicada(s)`);

  const after = await query("SELECT version FROM fdp_cards WHERE workspace_id = $1 AND id = $2", [id("w"), id("card")]);
  check("demanda: a versão avançou exatamente uma vez",
    Number(after.rows[0].version) === seen + 1, `versão ${seen} → ${after.rows[0].version}`);
}

/* 2. Dois webhooks idênticos ao mesmo tempo. */
async function twoWebhooks() {
  const insert = () => query(
    `INSERT INTO fdp_integration_events
       (id, workspace_id, integration_id, connector, event_type, external_event_id, source, status)
     VALUES ($1, $2, $3, 'teams', 'channel_message', $4, 'webhook', 'received')
     ON CONFLICT (workspace_id, integration_id, external_event_id) DO NOTHING RETURNING id`,
    [`${id("evt")}-${Math.random().toString(36).slice(2)}`, id("w"), id("int"), id("msg")],
  );
  const { a, b } = await inParallel(insert, insert);
  const created = [a, b].filter((result) => result.rowCount === 1).length;
  check("webhook: entrega duplicada simultânea cria um evento só", created === 1, `${created} evento(s)`);
}

/* 3. Dois trabalhadores disputando o mesmo evento. */
async function twoWorkers() {
  const eventId = `${id("evt2")}`;
  await query(
    `INSERT INTO fdp_integration_events
       (id, workspace_id, integration_id, connector, event_type, external_event_id, source, status)
     VALUES ($1, $2, $3, 'teams', 'channel_message', $4, 'webhook', 'received')
     ON CONFLICT DO NOTHING`,
    [eventId, id("w"), id("int"), id("msg2")],
  );
  const claim = () => query(
    `UPDATE fdp_integration_events SET status = 'processing', updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND status IN ('received', 'error', 'reprocessed')
      RETURNING id`,
    [id("w"), eventId],
  );
  const { a, b } = await inParallel(claim, claim);
  const claimed = [a, b].filter((result) => result.rowCount === 1).length;
  check("workers: dois trabalhadores, um único dono do trabalho", claimed === 1, `${claimed} lease(s)`);
}

/* 4. Duas aprovações simultâneas da mesma etapa. */
async function twoApprovals() {
  await query(`INSERT INTO fdp_companies (id, workspace_id, legal_name, trade_name, status)
    VALUES ($1, $2, 'Empresa Ensaio', 'Ensaio', 'active') ON CONFLICT (id) DO NOTHING`, [id("co"), id("w")]);
  await query(`INSERT INTO fdp_employees
      (id, workspace_id, company_id, registration_number, full_name, admission_date, created_by, updated_by)
    VALUES ($1, $2, $3, $4, 'Colaborador Ensaio', CURRENT_DATE, $5, $5) ON CONFLICT (id) DO NOTHING`,
  [id("emp"), id("w"), id("co"), id("mat"), id("u")]);
  await query(`INSERT INTO fdp_employee_movements
      (id, workspace_id, company_id, employee_id, movement_type, effective_date, title, status, requested_by)
    VALUES ($1, $2, $3, $4, 'other', CURRENT_DATE, 'Movimentação do ensaio', 'pending_approval', $5)
    ON CONFLICT (id) DO NOTHING`, [id("mov"), id("w"), id("co"), id("emp"), id("u")]);
  await query(`INSERT INTO fdp_movement_approval_steps
      (id, workspace_id, movement_id, sequence, approver_user_id, status)
    VALUES ($1, $2, $3, 1, $4, 'pending') ON CONFLICT (id) DO NOTHING`,
  [id("step"), id("w"), id("mov"), id("u")]);

  const decide = (decisao) => query(
    `UPDATE fdp_movement_approval_steps SET status = $1, decided_at = now()
      WHERE workspace_id = $2 AND id = $3 AND status = 'pending' RETURNING id`,
    [decisao, id("w"), id("step")],
  );
  const { a, b } = await inParallel(() => decide("approved"), () => decide("rejected"));
  const decided = [a, b].filter((result) => result.rowCount === 1).length;
  check("aprovação: duas decisões simultâneas, uma prevalece", decided === 1, `${decided} decisão(ões)`);
}

/* 5. Duas requisições de fechamento simultâneas. */
async function twoClosings() {
  await query(`INSERT INTO fdp_payroll_cycles (id, workspace_id, company_id, competence, status, created_by)
    VALUES ($1, $2, $3, '2026-08', 'open', $4) ON CONFLICT (id) DO NOTHING`,
  [id("cyc"), id("w"), id("co"), id("u")]);
  await query(`INSERT INTO fdp_auxiliary_providers (id, workspace_id, provider_type, code, legal_name, status)
    VALUES ($1, $2, 'contractor', $3, 'Prestador Ensaio', 'active') ON CONFLICT (id) DO NOTHING`,
  [id("prov"), id("w"), id("provcode")]);
  await query(`INSERT INTO fdp_contractor_closings
      (id, workspace_id, company_id, provider_id, payroll_cycle_id, competence, calc_version, status, created_by)
    VALUES ($1, $2, $3, $4, $5, '2026-08', 1, 'approved', $6) ON CONFLICT (id) DO NOTHING`,
  [id("clo"), id("w"), id("co"), id("prov"), id("cyc"), id("u")]);

  const close = () => query(
    `UPDATE fdp_contractor_closings SET status = 'closed', closed_at = now(), closed_by = $1
      WHERE workspace_id = $2 AND id = $3 AND status = 'approved' RETURNING id`,
    [id("u"), id("w"), id("clo")],
  );
  const { a, b } = await inParallel(close, close);
  const closed = [a, b].filter((result) => result.rowCount === 1).length;
  check("fechamento: duas requisições simultâneas, um único fechamento", closed === 1, `${closed} fechamento(s)`);

  const row = await query("SELECT version FROM fdp_contractor_closings WHERE workspace_id = $1 AND id = $2",
    [id("w"), id("clo")]);
  check("fechamento: a versão do registro acompanhou a alteração",
    Number(row.rows[0].version) === 2, `versão ${row.rows[0].version}`);
}

try {
  await setup();
  await twoEditors();
  await twoWebhooks();
  await twoWorkers();
  await twoApprovals();
  await twoClosings();
} finally {
  await cleanup();
  await pool.end();
}

const falhas = results.filter((result) => !result.ok);
console.log(`\nEnsaio de concorrência: ${results.length - falhas.length}/${results.length} verificações aprovadas.`);
if (falhas.length) process.exitCode = 1;
