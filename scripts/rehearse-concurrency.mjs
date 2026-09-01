/**
 * Ensaio de concorrência contra PostgreSQL real (§35).
 *
 * O ponto do §35 é direto: **idempotência comprovada por teste sequencial não é
 * idempotência comprovada**. Chamar a mesma função duas vezes em sequência
 * passa por qualquer verificação em código; o que quebra em produção são duas
 * conexões chegando ao mesmo tempo, cada uma vendo o estado anterior à outra.
 *
 * Por isso este ensaio abre conexões de verdade e dispara em paralelo. Ele
 * cobre os casos gerais já existentes e os cinco riscos exigidos pela auditoria:
 * estoque, tarefas, avanço de etapa, aprovações e versionamento de processo.
 *
 * Cada caso usa conexões PostgreSQL distintas e operações realmente paralelas.
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

/** Consulta transacional com o contexto tenant exigido pela função de estoque. */
async function workspaceQuery(text, values = []) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [id("w")]);
    const result = await client.query(text, values);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/* 6. Duas baixas disputando a última unidade do estoque. */
async function twoStockConsumers() {
  await query(`INSERT INTO fdp_stock_locations
      (id, workspace_id, code, name, status, is_default, created_by, updated_by)
    VALUES ($1, $2, 'ENSAIO', 'Estoque Ensaio', 'active', 1, $3, $3)
    ON CONFLICT (workspace_id, code) DO NOTHING`, [id("loc"), id("w"), id("u")]);
  await query(`INSERT INTO fdp_epi_products
      (id, workspace_id, name, epi_type, ca_number, size, brand, model,
       unit_value, stock_quantity, registered_on, status, registration_reason, created_by, updated_by)
    VALUES ($1, $2, 'Capacete Ensaio', 'head', $3, 'U', 'Ensaio', 'E1',
      10, 0, CURRENT_DATE, 'active', 'initial_purchase', $4, $4)
    ON CONFLICT (id) DO NOTHING`, [id("epi"), id("w"), id("ca"), id("u")]);

  await workspaceQuery("SELECT fdp_apply_stock_change($1, $2, $3, 1, $4)",
    [id("w"), id("epi"), id("loc"), id("u")]);
  const consume = () => workspaceQuery("SELECT fdp_apply_stock_change($1, $2, $3, -1, $4)",
    [id("w"), id("epi"), id("loc"), id("u")]);
  const { a, b } = await inParallel(consume, consume);
  const applied = [a, b].filter((result) => result.rowCount === 1).length;
  check("estoque: duas baixas disputam a última unidade, uma vence", applied === 1, `${applied} baixa(s)`);

  const balance = await query(`SELECT quantity, version FROM fdp_stock_balances
    WHERE workspace_id = $1 AND product_id = $2 AND stock_location_id = $3`,
  [id("w"), id("epi"), id("loc")]);
  check("estoque: saldo nunca fica negativo",
    Number(balance.rows[0].quantity) === 0 && Number(balance.rows[0].version) === 2,
    `saldo ${balance.rows[0].quantity}; versão ${balance.rows[0].version}`);
}

/* 7. Duas conclusões simultâneas da mesma tarefa. */
async function twoTaskCompletions() {
  await query(`INSERT INTO fdp_checklist_items (id, workspace_id, card_id, title, completed, position)
    VALUES ($1, $2, $3, 'Tarefa concorrente', 0, 1000) ON CONFLICT (id) DO NOTHING`,
  [id("task"), id("w"), id("card")]);
  const complete = () => query(`UPDATE fdp_checklist_items
      SET completed = 1, completed_at = now(), completed_by = 'ensaio@local'
      WHERE workspace_id = $1 AND id = $2 AND completed IS DISTINCT FROM 1 RETURNING id`,
    [id("w"), id("task")]);
  const { a, b } = await inParallel(complete, complete);
  const applied = [a, b].filter((result) => result.rowCount === 1).length;
  check("tarefa: duas conclusões simultâneas geram uma única mudança", applied === 1, `${applied} mudança(s)`);
}

/* Prepara uma versão e uma demanda para os ensaios de etapa e versionamento. */
async function prepareProcessConcurrency() {
  await query(`INSERT INTO fdp_process_definitions
      (id, workspace_id, code, name, category, status, created_by, updated_by)
    VALUES ($1, $2, $3, 'Processo Concorrente', 'general', 'active', $4, $4)
    ON CONFLICT (id) DO NOTHING`, [id("proc"), id("w"), id("pcode"), id("u")]);
  await query(`INSERT INTO fdp_process_versions
      (id, workspace_id, definition_id, version, status, configuration_json,
       version_major, version_minor, revision, created_by, updated_by)
    VALUES ($1, $2, $3, 1, 'draft', '{}'::jsonb, 1, 0, 0, $4, $4)
    ON CONFLICT (id) DO NOTHING`, [id("pv"), id("w"), id("proc"), id("u")]);
  await query(`INSERT INTO fdp_cards
      (id, workspace_id, board_id, list_id, title, position, created_by,
       process_definition_id, process_version_id, process_version_number, current_step_id, instantiated_at)
    VALUES ($1, $2, $3, $4, 'Demanda com etapa', 2000, 'ensaio@local',
      $5, $6, '1.0', 'etapa-a', now()) ON CONFLICT (id) DO NOTHING`,
  [id("pcard"), id("w"), id("b"), id("l"), id("proc"), id("pv")]);
  await query(`INSERT INTO fdp_demand_stages
      (id, workspace_id, card_id, process_version_id, bpmn_element_id, title, status, position)
    VALUES ($1, $2, $3, $4, 'etapa-a', 'Etapa A', 'in_progress', 1000)
    ON CONFLICT (id) DO NOTHING`, [id("stage"), id("w"), id("pcard"), id("pv")]);
}

/* 8. Dois avanços simultâneos da mesma etapa persistida. */
async function twoStageAdvances() {
  const advance = () => query(`UPDATE fdp_demand_stages
      SET status = 'completed', completed_at = now(), updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND status = 'in_progress' AND version = 1
      RETURNING version`, [id("w"), id("stage")]);
  const { a, b } = await inParallel(advance, advance);
  const applied = [a, b].filter((result) => result.rowCount === 1).length;
  check("etapa: dois avanços simultâneos, um único fechamento", applied === 1, `${applied} avanço(s)`);
  const row = await query("SELECT status, version FROM fdp_demand_stages WHERE workspace_id = $1 AND id = $2",
    [id("w"), id("stage")]);
  check("etapa: estado e versão permanecem coerentes",
    row.rows[0].status === "completed" && Number(row.rows[0].version) === 2,
    `${row.rows[0].status}; versão ${row.rows[0].version}`);
}

/* 9. Dois autosaves da mesma revisão do processo. */
async function twoProcessVersionSaves() {
  const save = (summary) => query(`SELECT fdp_save_process_version_draft(
      $1, $2, 0, '', '', jsonb_build_object('summary', $3), '[]'::jsonb, $4) AS revision`,
    [id("w"), id("pv"), summary, id("u")]);
  const { a, b } = await inParallel(() => save("A"), () => save("B"));
  const applied = [a, b].filter((result) => result.rowCount === 1).length;
  const rejected = [a, b].filter((result) => result.error).length;
  check("processo: dois autosaves da mesma revisão, um vence e um recebe conflito",
    applied === 1 && rejected === 1, `${applied} salvo(s); ${rejected} conflito(s)`);
  const row = await query("SELECT revision FROM fdp_process_versions WHERE workspace_id = $1 AND id = $2",
    [id("w"), id("pv")]);
  check("processo: revisão avança exatamente uma vez", Number(row.rows[0].revision) === 1,
    `revisão ${row.rows[0].revision}`);
}

try {
  await setup();
  await twoEditors();
  await twoWebhooks();
  await twoWorkers();
  await twoApprovals();
  await twoStockConsumers();
  await twoTaskCompletions();
  await prepareProcessConcurrency();
  await twoStageAdvances();
  await twoProcessVersionSaves();
  await twoClosings();
} finally {
  await cleanup();
  await pool.end();
}

const falhas = results.filter((result) => !result.ok);
console.log(`\nEnsaio de concorrência: ${results.length - falhas.length}/${results.length} verificações aprovadas.`);
if (falhas.length) process.exitCode = 1;
