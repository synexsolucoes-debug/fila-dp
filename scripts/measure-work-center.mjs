/**
 * Medição das telas novas contra PostgreSQL real, com volume (§68).
 *
 * "Definir limites razoáveis" só significa alguma coisa depois de medir. Este
 * ensaio semeia um workspace com volume de cliente grande — vinte mil demandas,
 * mais aprovações, movimentações, pendências, triagem e execuções mortas — e
 * mede o que a Central de Trabalho, a Triagem, os Agentes e a ficha de processo
 * realmente executam.
 *
 * O que ele mede é o **plano e o tempo** de cada consulta, com `EXPLAIN
 * ANALYZE`. Medir o endpoint inteiro incluiria rede, serialização e a máquina
 * de quem roda o ensaio; o que decide se a tela abre em meio segundo ou em
 * quinze é a consulta.
 *
 * Tudo o que ele semeia é removido no fim, e o workspace é próprio: o ensaio
 * nunca toca em dado que já estava lá.
 *
 * Uso:
 *   DATABASE_URL=postgres://... node scripts/measure-work-center.mjs
 */
const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.NEON_DATABASE_URL;
if (!databaseUrl?.startsWith("postgres")) {
  throw new Error("Defina DATABASE_URL com uma conexão PostgreSQL com as migrations aplicadas.");
}

const {
  workItemSources, buildWorkCenterQuery, buildWorkCountsQuery, buildWorkGroupQuery, emptyWorkItemFilters,
} = await import("../lib/work-items.ts");
const { toPostgresParameters } = await import("../lib/postgres-parameters.ts");
const { Client } = await import("pg");

const CARDS = Number(process.env.MEASURE_CARDS ?? 20_000);
const SIDE_ROWS = Number(process.env.MEASURE_SIDE_ROWS ?? 2_000);

const client = new Client({ connectionString: databaseUrl });
await client.connect();

const suffix = Math.random().toString(36).slice(2, 10);
const id = (prefix) => `${prefix}-${suffix}`;
const measurements = [];

async function seed() {
  await client.query(`INSERT INTO fdp_users (id, email, name) VALUES ($1, $2, 'Medição')`,
    [id("u"), `${id("u")}@medicao.local`]);
  await client.query(`INSERT INTO fdp_workspaces (id, name, slug, owner_user_id) VALUES ($1, 'Medição', $2, $3)`,
    [id("w"), id("slug"), id("u")]);
  await client.query(`INSERT INTO fdp_workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`,
    [id("w"), id("u")]);
  await client.query(`INSERT INTO fdp_boards (id, workspace_id, name, board_type) VALUES ($1, $2, 'Quadro', 'operational')`,
    [id("b"), id("w")]);
  await client.query(`INSERT INTO fdp_lists (id, workspace_id, board_id, name, kind, position)
    VALUES ($1, $2, $3, 'Novas', 'new', 1000)`, [id("l"), id("w"), id("b")]);
  await client.query(`INSERT INTO fdp_companies (id, workspace_id, legal_name, trade_name, tax_id, status)
    SELECT $1 || '-' || g, $2, 'Empresa ' || g, 'Empresa ' || g, lpad(g::text, 14, '0'), 'active'
    FROM generate_series(1, 10) g`, [id("co"), id("w")]);
  await client.query(`INSERT INTO fdp_integrations (id, workspace_id, channel, display_name, status)
    VALUES ($1, $2, 'tangerino', 'Tangerino', 'connected')`, [id("int"), id("w")]);
  /* A definição aponta para a versão e a versão aponta para a definição: a
     ordem é criar a definição sem versão vigente, criar a versão, e só então
     apontá-la. É o mesmo caminho que a publicação usa. */
  await client.query(`INSERT INTO fdp_process_definitions (id, workspace_id, code, name)
    VALUES ($1, $2, $3, 'Processo de medição')`, [id("proc"), id("w"), id("cod")]);
  await client.query(`INSERT INTO fdp_process_versions (id, workspace_id, definition_id, version, status, created_by)
    VALUES ($1, $2, $3, 2, 'published', $4)`,
  [`${id("proc")}-versao`, id("w"), id("proc"), id("u")]);
  await client.query("UPDATE fdp_process_definitions SET current_version_id = $1 WHERE workspace_id = $2 AND id = $3",
    [`${id("proc")}-versao`, id("w"), id("proc")]);

  await client.query(`INSERT INTO fdp_employees
      (id, workspace_id, company_id, registration_number, full_name, admission_date, created_by, updated_by)
    SELECT $1 || '-' || g, $2, $3 || '-' || (1 + g % 10), 'M' || g, 'Colaborador ' || g,
      current_date - (g % 900), $4, $4
    FROM generate_series(1, 200) g`, [id("emp"), id("w"), id("co"), id("u")]);

  // Demandas: metade com processo, um terço vencidas, distribuídas por empresa.
  await client.query(`INSERT INTO fdp_cards
      (id, workspace_id, board_id, list_id, title, description, company_id, company, process_type,
       priority, due_at, sla_status, position, source_type, created_by, current_step_id,
       process_definition_id, process_version_id, process_version_number, instantiated_at, created_at, updated_at)
    SELECT $1 || '-' || g, $2, $3, $4, 'Demanda ' || g, 'Ensaio de medição',
      $5 || '-' || (1 + g % 10), 'Empresa', 'CONCILIAÇÃO CADASTRAL',
      CASE WHEN g % 17 = 0 THEN 'urgent' ELSE 'normal' END,
      now() + make_interval(days => (g % 40) - 20),
      CASE WHEN g % 3 = 0 THEN 'overdue' WHEN g % 3 = 1 THEN 'warning' ELSE 'safe' END,
      g * 1000, CASE WHEN g % 4 = 0 THEN 'integracao:tangerino' ELSE 'manual' END, 'medicao@local',
      -- Metade das demandas nasce de processo. A restrição do banco exige o
      -- conjunto inteiro ou nenhum campo: é ela que impede uma demanda "meio
      -- instanciada", e o ensaio precisa respeitá-la como o produto respeita.
      CASE WHEN g % 2 = 0 THEN 'Etapa_' || (g % 5) ELSE '' END,
      CASE WHEN g % 2 = 0 THEN $6 ELSE NULL END,
      CASE WHEN g % 2 = 0 THEN $6 || '-versao' ELSE NULL END,
      CASE WHEN g % 2 = 0 THEN '2.0' ELSE '' END,
      CASE WHEN g % 2 = 0 THEN now() - make_interval(days => g % 300) ELSE NULL END,
      now() - make_interval(days => g % 300), now() - make_interval(days => g % 90)
    FROM generate_series(1, $7::int) g`,
  [id("card"), id("w"), id("b"), id("l"), id("co"), id("proc"), CARDS]);

  await client.query(`INSERT INTO fdp_card_assignees (workspace_id, card_id, user_id)
    SELECT $1, $2 || '-' || g, $3 FROM generate_series(1, $4::int) g WHERE g % 5 = 0`,
  [id("w"), id("card"), id("u"), CARDS]);

  /* A empresa da movimentação sai do próprio colaborador, e não de uma conta
     paralela: a chave composta (grupo, empresa, colaborador) recusa qualquer
     combinação que não exista — que é exatamente o que ela existe para fazer. */
  await client.query(`INSERT INTO fdp_employee_movements
      (id, workspace_id, company_id, employee_id, movement_type, effective_date, title, status, requested_by, created_at)
    SELECT $1 || '-' || g, $2, e.company_id, e.id, 'salary_change',
      current_date + ((g % 30) - 15), 'Movimentação ' || g,
      CASE WHEN g % 3 = 0 THEN 'draft' WHEN g % 3 = 1 THEN 'pending_approval' ELSE 'rejected' END,
      $3, now() - make_interval(days => g % 120)
    FROM generate_series(1, $4::int) g
    JOIN fdp_employees e ON e.workspace_id = $2 AND e.id = $5 || '-' || (1 + g % 200)`,
  [id("mov"), id("w"), id("u"), SIDE_ROWS, id("emp")]);

  await client.query(`INSERT INTO fdp_movement_approval_steps
      (id, workspace_id, movement_id, sequence, approver_user_id, status)
    SELECT $1 || '-' || g, $2, $3 || '-' || g, 1, $4, 'pending'
    FROM generate_series(1, $5::int) g`,
  [id("apr"), id("w"), id("mov"), id("u"), SIDE_ROWS]);

  await client.query(`INSERT INTO fdp_operational_pending_items
      (id, workspace_id, company_id, title, source_type, source_id, idempotency_key, status, blocking, due_date, created_at)
    SELECT $1 || '-' || g, $2, $3 || '-' || (1 + g % 10), 'Pendência ' || g, 'cycle', 'origem-' || g, 'medicao-' || g,
      CASE WHEN g % 2 = 0 THEN 'open' ELSE 'in_progress' END, (g % 4 = 0)::int,
      current_date + ((g % 20) - 10), now() - make_interval(days => g % 60)
    FROM generate_series(1, $4::int) g`,
  [id("pend"), id("w"), id("co"), SIDE_ROWS]);

  /* A sugestão do Teams aponta para o evento que a originou — a idempotência
     do produto começa ali, e o ensaio semeia o caminho inteiro em vez de uma
     linha solta que o banco recusaria. */
  await client.query(`INSERT INTO fdp_integration_events
      (id, workspace_id, integration_id, connector, event_type, external_event_id, source, status)
    SELECT $1 || '-' || g, $2, $3, 'teams', 'channel_message', 'msg-' || g, 'webhook', 'processed'
    FROM generate_series(1, 500) g`, [id("evt"), id("w"), id("int")]);
  await client.query(`INSERT INTO fdp_movement_suggestions
      (id, workspace_id, integration_id, event_id, movement_kind, status, confidence, employee_name,
       requested_by_name, team_name, channel_name, message_id, original_message, created_at)
    SELECT $1 || '-' || g, $2, $3, $4 || '-' || g, 'salary_change', 'pending', 40 + (g % 55), 'Colaborador ' || g,
      'Gestor', 'Equipe', 'Canal', 'msg-' || g, 'Mensagem de ensaio', now() - make_interval(days => g % 30)
    FROM generate_series(1, 500) g`, [id("sug"), id("w"), id("int"), id("evt")]);

  await client.query(`INSERT INTO fdp_agent_proposals
      (id, workspace_id, agent_key, event_id, event_name, entity_type, entity_id, proposed_action,
       reason, confidence, status, decision_code, created_at)
    SELECT $1 || '-' || g, $2, 'tangerino', 'evt-' || g, 'agent.proposal_created', 'employee', '',
      'process.advance', 'Leitura automática', 30 + (g % 60),
      CASE WHEN g % 3 = 0 THEN 'pending_triage' ELSE 'suggested' END,
      'AGENT_LOW_CONFIDENCE', now() - make_interval(days => g % 45)
    FROM generate_series(1, 1000) g`, [id("prop"), id("w")]);

  await client.query("ANALYZE fdp_cards, fdp_employee_movements, fdp_movement_approval_steps, fdp_operational_pending_items, fdp_movement_suggestions, fdp_agent_proposals");
}

async function cleanup() {
  await client.query("DELETE FROM fdp_workspaces WHERE id = $1", [id("w")]).catch(() => undefined);
  await client.query("DELETE FROM fdp_users WHERE id = $1", [id("u")]).catch(() => undefined);
}

/** Executa o plano três vezes e fica com a mediana: uma leitura fria mede o disco. */
async function measure(label, sql, parameters) {
  const times = [];
  let plan = "";
  for (let round = 0; round < 3; round += 1) {
    const explained = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${toPostgresParameters(sql)}`, parameters,
    );
    const result = explained.rows[0]["QUERY PLAN"][0];
    times.push(Number(result["Execution Time"]));
    plan = result.Plan["Node Type"];
  }
  times.sort((left, right) => left - right);
  const median = times[1];
  measurements.push({ label, ms: median, plan });
  console.log(`${median.toFixed(1).padStart(8)} ms  ${label}  (${plan})`);
  return median;
}

const shared = {
  sources: workItemSources, workspaceId: id("w"), userId: id("u"), companyIds: null,
};

try {
  console.log(`Semeando ${CARDS} demandas e ${SIDE_ROWS} registros por fonte auxiliar…`);
  await seed();
  console.log("");

  for (const sort of ["urgency", "due", "created", "updated"]) {
    const query = buildWorkCenterQuery({
      ...shared, filters: { ...emptyWorkItemFilters, scope: "team" }, sort, cursor: [], limit: 25,
    });
    await measure(`Central de Trabalho — equipe, ordem por ${sort}`, query.sql, query.parameters);
  }

  const mine = buildWorkCenterQuery({
    ...shared, filters: { ...emptyWorkItemFilters, scope: "mine" }, sort: "urgency", cursor: [], limit: 25,
  });
  await measure("Central de Trabalho — meus itens", mine.sql, mine.parameters);

  const scoped = buildWorkCenterQuery({
    ...shared, companyIds: [`${id("co")}-1`, `${id("co")}-2`],
    filters: { ...emptyWorkItemFilters, scope: "team", due: "overdue" }, sort: "urgency", cursor: [], limit: 25,
  });
  await measure("Central de Trabalho — duas empresas, só vencidos", scoped.sql, scoped.parameters);

  const counts = buildWorkCountsQuery({ ...shared, scope: "team" });
  await measure("Central de Trabalho — contadores", counts.sql, counts.parameters);

  const grouped = buildWorkGroupQuery({ ...shared, scope: "team", group: "source" });
  await measure("Central de Trabalho — agrupamento por origem", grouped.sql, grouped.parameters);

  await measure("Triagem — página inicial",
    `SELECT p.id, p.agent_key, p.status, p.confidence, p.decision_code, p.created_at
       FROM fdp_agent_proposals p
      WHERE p.workspace_id = ? AND p.status IN ('pending_triage', 'suggested')
      ORDER BY p.created_at DESC LIMIT 25`, [id("w")]);

  await measure("Triagem — contadores",
    `SELECT
        (SELECT count(*)::int FROM fdp_agent_proposals a WHERE a.workspace_id = ? AND a.status = 'pending_triage') AS pending_triage,
        (SELECT count(*)::int FROM fdp_agent_proposals a WHERE a.workspace_id = ? AND a.status = 'suggested') AS suggested,
        (SELECT count(*)::int FROM fdp_movement_suggestions m WHERE m.workspace_id = ? AND m.status = 'pending') AS movements`,
    [id("w"), id("w"), id("w")]);

  await measure("Agentes — propostas por agente",
    `SELECT p.agent_key,
        count(*) FILTER (WHERE p.status = 'pending_triage')::int AS pending_triage,
        count(*) FILTER (WHERE p.status = 'suggested')::int AS suggested
      FROM fdp_agent_proposals p WHERE p.workspace_id = ? GROUP BY p.agent_key`, [id("w")]);

  await measure("Processo — uso",
    `SELECT
        count(*) FILTER (WHERE c.closed_at IS NULL)::int AS open,
        count(*) FILTER (WHERE c.closed_at IS NOT NULL)::int AS completed,
        avg(EXTRACT(EPOCH FROM (c.closed_at - c.created_at)) / 3600) FILTER (WHERE c.closed_at IS NOT NULL) AS average_hours
      FROM fdp_cards c WHERE c.workspace_id = ? AND c.process_definition_id = ? AND c.archived = 0`,
    [id("w"), id("proc")]);

  await measure("Processo — onde as demandas estão paradas",
    `SELECT c.current_step_id AS step_id, count(*)::int AS open
       FROM fdp_cards c
      WHERE c.workspace_id = ? AND c.process_definition_id = ? AND c.archived = 0
        AND c.closed_at IS NULL AND COALESCE(c.current_step_id, '') <> ''
      GROUP BY c.current_step_id ORDER BY 2 DESC LIMIT 5`, [id("w"), id("proc")]);
} finally {
  await cleanup();
  await client.end();
}

/**
 * O limite (§68).
 *
 * Meio segundo por consulta de tela, com volume de cliente grande. Acima disso
 * a tela deixa de parecer instantânea e a pessoa começa a clicar duas vezes —
 * que é como uma lista lenta vira uma lista errada.
 */
const LIMIT_MS = 500;
const acima = measurements.filter((item) => item.ms > LIMIT_MS);
console.log(`\nMedições: ${measurements.length} consultas, teto de ${LIMIT_MS} ms.`);
if (acima.length) {
  for (const item of acima) console.error(`ACIMA DO TETO  ${item.label}: ${item.ms.toFixed(1)} ms`);
  process.exitCode = 1;
} else {
  const pior = measurements.reduce((worst, item) => (item.ms > worst.ms ? item : worst));
  console.log(`Pior caso: ${pior.label} — ${pior.ms.toFixed(1)} ms.`);
}
