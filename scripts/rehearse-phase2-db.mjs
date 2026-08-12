import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";
import { splitPostgresStatements } from "./sql-statements.mjs";

const databaseUrl = process.env.FDP_PHASE2_TEST_DATABASE_URL;
if (!databaseUrl?.startsWith("postgres")) {
  throw new Error("Defina FDP_PHASE2_TEST_DATABASE_URL apontando para um PostgreSQL de teste dedicado.");
}
if (process.env.FDP_ALLOW_EPHEMERAL_SCHEMA_TEST !== "true") {
  throw new Error("Defina FDP_ALLOW_EPHEMERAL_SCHEMA_TEST=true para autorizar a criação e remoção do schema efêmero.");
}

const schema = `fdp_phase2_${randomBytes(8).toString("hex")}`;
const testRole = `fdp_phase2_role_${randomBytes(8).toString("hex")}`;
if (!/^fdp_phase2_role_[0-9a-f]{16}$/u.test(testRole)) throw new Error("Invalid ephemeral test role name.");
if (!/^fdp_phase2_[0-9a-f]{16}$/u.test(schema)) throw new Error("Nome de schema efêmero inválido.");

const sql = neon(databaseUrl, { fullResults: true });
const migrationsDirectory = join(process.cwd(), "drizzle", "postgres");
const migrationFiles = (await readdir(migrationsDirectory)).filter((file) => /^\d{4}_.+\.sql$/u.test(file)).sort();

function schemaQuery(statement, parameters = []) {
  return [
    sql.query("SELECT set_config('search_path', $1, true)", [schema]),
    sql.query(`SET LOCAL ROLE "${testRole}"`, []),
    sql.query(statement, parameters),
  ];
}

function tenantQueries(workspaceId, userId, statements) {
  return [
    sql.query("SELECT set_config('search_path', $1, true)", [schema]),
    sql.query(`SET LOCAL ROLE "${testRole}"`, []),
    sql.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]),
    sql.query("SELECT set_config('app.user_id', $1, true)", [userId]),
    ...statements.map(({ statement, parameters = [] }) => sql.query(statement, parameters)),
  ];
}

function platformQueries(userId, statements) {
  return [
    sql.query("SELECT set_config('search_path', $1, true)", [schema]),
    sql.query(`SET LOCAL ROLE "${testRole}"`, []),
    sql.query("SELECT set_config('app.platform_admin', 'true', true)"),
    sql.query("SELECT set_config('app.user_id', $1, true)", [userId]),
    ...statements.map(({ statement, parameters = [] }) => sql.query(statement, parameters)),
  ];
}

await sql.query(`CREATE SCHEMA "${schema}"`, []);
let roleCreated = false;
try {
  await sql.query(`CREATE ROLE "${testRole}" NOLOGIN NOSUPERUSER NOBYPASSRLS`, []);
  roleCreated = true;
  await sql.query(`GRANT "${testRole}" TO CURRENT_USER`, []);
  let cleanBaseline = false;
  for (const file of migrationFiles) {
    // O baseline 0000 já nasce com timestamps PostgreSQL. A normalização 0001
    // existe somente para instalações legadas cujas colunas ainda eram texto;
    // executá-la sobre um schema limpo faz o PostgreSQL tentar comparar
    // timestamptz com '' antes do cast e mascara o ensaio de RLS.
    if (file.includes("normalize_existing") && cleanBaseline) continue;
    const source = await readFile(join(migrationsDirectory, file), "utf8");
    const isolatedSource = source.replaceAll('"public".', `"${schema}".`);
    const statements = splitPostgresStatements(isolatedSource);
    let ordered = statements;
    // As migrations 0014-0017 vieram de um gerador que posicionou alguns
    // índices únicos compostos depois das FKs que dependem deles. O migrador e
    // os outros ensaios preservam a intenção trazendo esses índices para antes
    // da primeira FK; o ensaio isolado precisa executar a mesma ordem.
    if (/^001[4-7]_/u.test(file)) {
      const uniqueIndexes = statements.filter((statement) => /\bCREATE UNIQUE INDEX\b/u.test(statement));
      const remaining = statements.filter((statement) => !/\bCREATE UNIQUE INDEX\b/u.test(statement));
      const firstForeignKey = remaining.findIndex((statement) => /\bALTER TABLE\b[\s\S]+\bADD CONSTRAINT\b/u.test(statement));
      if (firstForeignKey >= 0 && uniqueIndexes.length > 0) {
        ordered = [...remaining.slice(0, firstForeignKey), ...uniqueIndexes, ...remaining.slice(firstForeignKey)];
      }
    }
    await sql.transaction([
      sql.query("SELECT set_config('search_path', $1, true)", [schema]),
      ...ordered.map((statement) => sql.query(statement, [])),
    ]);
    if (file.startsWith("0000_")) cleanBaseline = true;
  }

  await sql.transaction([
    sql.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${testRole}"`, []),
    sql.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${testRole}"`, []),
    sql.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${testRole}"`, []),
    sql.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "${schema}" TO "${testRole}"`, []),
  ]);

  const workspaceA = "phase2-workspace-a";
  const workspaceB = "phase2-workspace-b";
  const userA = "phase2-user-a";
  const userB = "phase2-user-b";
  await sql.transaction([
    sql.query("SELECT set_config('search_path', $1, true)", [schema]),
    sql.query("INSERT INTO fdp_users (id, email, name) VALUES ($1, 'phase2-a@example.invalid', 'Phase 2 A'), ($2, 'phase2-b@example.invalid', 'Phase 2 B')", [userA, userB]),
    sql.query("INSERT INTO fdp_workspaces (id, name, slug, owner_user_id) VALUES ($1, 'Phase 2 A', 'phase2-a', $2), ($3, 'Phase 2 B', 'phase2-b', $4)", [workspaceA, userA, workspaceB, userB]),
    sql.query("INSERT INTO fdp_workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin'), ($3, $4, 'admin')", [workspaceA, userA, workspaceB, userB]),
  ]);

  for (const [workspaceId, userId, suffix] of [[workspaceA, userA, "a"], [workspaceB, userB, "b"]]) {
    await sql.transaction(tenantQueries(workspaceId, userId, [
      { statement: "INSERT INTO fdp_boards (id, workspace_id, name) VALUES ($1, $2, $3)", parameters: [`board-${suffix}`, workspaceId, `Board ${suffix}`] },
      { statement: "INSERT INTO fdp_lists (id, workspace_id, board_id, name, kind, position) VALUES ($1, $2, $3, $4, 'new', 1000)", parameters: [`list-${suffix}`, workspaceId, `board-${suffix}`, `List ${suffix}`] },
      { statement: "INSERT INTO fdp_cards (id, workspace_id, board_id, list_id, title, position, created_by) VALUES ($1, $2, $3, $4, $5, 1000, $6)", parameters: [`card-${suffix}`, workspaceId, `board-${suffix}`, `list-${suffix}`, `Card ${suffix}`, userId] },
      { statement: "INSERT INTO fdp_audit_events (id, workspace_id, actor_user_id, actor_email, action, entity_type, entity_id) VALUES ($1, $2, $3, $4, 'card.created', 'card', $5)", parameters: [`audit-${suffix}`, workspaceId, userId, `phase2-${suffix}@example.invalid`, `card-${suffix}`] },
      { statement: "INSERT INTO fdp_companies (id, workspace_id, is_principal, legal_name) VALUES ($1, $2, 1, $3)", parameters: [`company-${suffix}`, workspaceId, `Company ${suffix}`] },
      { statement: "INSERT INTO fdp_departments (id, workspace_id, company_id, code, name) VALUES ($1, $2, $3, 'DP', 'Departamento Pessoal')", parameters: [`department-${suffix}`, workspaceId, `company-${suffix}`] },
      { statement: "INSERT INTO fdp_employees (id, workspace_id, company_id, department_id, registration_number, full_name, cpf_hash, cpf_last4, admission_date, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, '4725', '2026-08-01', $8, $8)", parameters: [`employee-${suffix}`, workspaceId, `company-${suffix}`, `department-${suffix}`, `MAT-${suffix}`, `Employee ${suffix}`, `hmac-only-${suffix}`, userId] },
      { statement: "INSERT INTO fdp_payroll_cycles (id, workspace_id, company_id, competence, created_by) VALUES ($1, $2, $3, '2026-08', $4)", parameters: [`cycle-${suffix}`, workspaceId, `company-${suffix}`, userId] },
      { statement: "INSERT INTO fdp_employee_movements (id, workspace_id, company_id, employee_id, payroll_cycle_id, movement_type, effective_date, title, requested_by) VALUES ($1, $2, $3, $4, $5, 'vacation', '2026-08-18', 'Férias programadas', $6)", parameters: [`movement-${suffix}`, workspaceId, `company-${suffix}`, `employee-${suffix}`, `cycle-${suffix}`, userId] },
      { statement: "INSERT INTO fdp_movement_approval_steps (id, workspace_id, movement_id, approver_user_id) VALUES ($1, $2, $3, $4)", parameters: [`approval-${suffix}`, workspaceId, `movement-${suffix}`, userId] },
      { statement: "INSERT INTO fdp_payroll_cycle_items (id, workspace_id, company_id, payroll_cycle_id, phase, title) VALUES ($1, $2, $3, $4, 'pre_closing', 'Conferir eventos')", parameters: [`closing-${suffix}`, workspaceId, `company-${suffix}`, `cycle-${suffix}`] },
      { statement: "INSERT INTO fdp_compliance_obligations (id, workspace_id, company_id, payroll_cycle_id, obligation_type, title, due_date, recurrence_key) VALUES ($1, $2, $3, $4, 'reporting', 'Enviar eSocial', '2026-08-31', $5)", parameters: [`obligation-${suffix}`, workspaceId, `company-${suffix}`, `cycle-${suffix}`, `esocial-2026-08-${suffix}`] },
      { statement: "INSERT INTO fdp_operational_pending_items (id, workspace_id, company_id, payroll_cycle_id, source_type, source_id, title, blocking, idempotency_key) VALUES ($1, $2, $3, $4, 'movement', $5, 'Validar movimentação', 1, $6)", parameters: [`pending-${suffix}`, workspaceId, `company-${suffix}`, `cycle-${suffix}`, `movement-${suffix}`, `pending-movement-${suffix}`] },
      { statement: "INSERT INTO fdp_process_definitions (id, workspace_id, code, name) VALUES ($1, $2, $3, 'Férias')", parameters: [`process-${suffix}`, workspaceId, `vacation-${suffix}`] },
      { statement: "INSERT INTO fdp_process_versions (id, workspace_id, definition_id, version, status, configuration_json, published_at, published_by, created_by) VALUES ($1, $2, $3, 1, 'published', '{\"steps\":[{\"key\":\"review\",\"name\":\"Revisão\"}]}'::jsonb, now(), $4, $4)", parameters: [`process-version-${suffix}`, workspaceId, `process-${suffix}`, userId] },
      { statement: "INSERT INTO fdp_auxiliary_providers (id, workspace_id, provider_type, code, legal_name) VALUES ($1, $2, 'benefit_operator', $3, 'Operadora de benefícios')", parameters: [`aux-provider-${suffix}`, workspaceId, `OPERATOR-${suffix}`] },
      { statement: "INSERT INTO fdp_auxiliary_executions (id, workspace_id, company_id, payroll_cycle_id, provider_id, module_type, reference_code, title, status, current_revision, created_by) VALUES ($1, $2, $3, $4, $5, 'benefits', $6, 'Fechamento de benefícios', 'pending_approval', 1, $7)", parameters: [`aux-execution-${suffix}`, workspaceId, `company-${suffix}`, `cycle-${suffix}`, `aux-provider-${suffix}`, `BENEFITS-2026-08-${suffix}`, userId] },
      { statement: "INSERT INTO fdp_auxiliary_execution_revisions (id, workspace_id, execution_id, revision, input_json, output_json, status, created_by) VALUES ($1, $2, $3, 1, '{\"participantsCount\":10}'::jsonb, '{\"processedCount\":10}'::jsonb, 'submitted', $4)", parameters: [`aux-revision-${suffix}`, workspaceId, `aux-execution-${suffix}`, userId] },
      { statement: "INSERT INTO fdp_auxiliary_approval_steps (id, workspace_id, execution_id, revision_id, approver_user_id) VALUES ($1, $2, $3, $4, $5)", parameters: [`aux-approval-${suffix}`, workspaceId, `aux-execution-${suffix}`, `aux-revision-${suffix}`, userId] },
      { statement: "INSERT INTO fdp_integrations (id, workspace_id, channel, display_name, status) VALUES ($1, $2, 'erp', 'ERP de teste', 'needs_credentials')", parameters: [`integration-${suffix}`, workspaceId] },
      { statement: "INSERT INTO fdp_integration_credentials (id, workspace_id, integration_id, encrypted_value, initialization_vector, auth_tag, key_version, fingerprint, created_by) VALUES ($1, $2, $3, 'ciphertext', 'initialization-vector', 'authentication-tag', 1, $4, $5)", parameters: [`credential-${suffix}`, workspaceId, `integration-${suffix}`, `fingerprint-${suffix}`, userId] },
      { statement: "INSERT INTO fdp_integration_mappings (id, workspace_id, integration_id, resource_type, direction, version, status, mapping_json, checksum, published_at, published_by, created_by) VALUES ($1, $2, $3, 'employees', 'inbound', 1, 'active', '{\"externalIdField\":\"id\",\"fields\":[{\"source\":\"name\",\"target\":\"fullName\",\"transform\":\"trim\",\"required\":true}]}'::jsonb, $4, now(), $5, $5)", parameters: [`mapping-${suffix}`, workspaceId, `integration-${suffix}`, `checksum-${suffix}`, userId] },
      { statement: "INSERT INTO fdp_integration_sync_runs (id, workspace_id, integration_id, mapping_id, trigger_type, status, idempotency_key, requested_by) VALUES ($1, $2, $3, $4, 'manual', 'queued', $5, $6)", parameters: [`sync-run-${suffix}`, workspaceId, `integration-${suffix}`, `mapping-${suffix}`, `idempotency-${suffix}`, userId] },
      { statement: "INSERT INTO fdp_integration_sync_items (id, workspace_id, integration_id, run_id, mapping_id, item_key, external_id, status, payload_hash, target_type) VALUES ($1, $2, $3, $4, $5, $6, $7, 'conflict', $8, 'employee')", parameters: [`sync-item-${suffix}`, workspaceId, `integration-${suffix}`, `sync-run-${suffix}`, `mapping-${suffix}`, `item-${suffix}`, `external-${suffix}`, `payload-hash-${suffix}`] },
      { statement: "INSERT INTO fdp_integration_jobs (id, workspace_id, integration_id, run_id, idempotency_key) VALUES ($1, $2, $3, $4, $5)", parameters: [`job-${suffix}`, workspaceId, `integration-${suffix}`, `sync-run-${suffix}`, `job-idempotency-${suffix}`] },
      { statement: "INSERT INTO fdp_integration_reconciliations (id, workspace_id, integration_id, run_id, item_id, entity_type, external_id, status, differences_json) VALUES ($1, $2, $3, $4, $5, 'employee', $6, 'conflict', '{\"fields\":[\"fullName\"]}'::jsonb)", parameters: [`reconciliation-${suffix}`, workspaceId, `integration-${suffix}`, `sync-run-${suffix}`, `sync-item-${suffix}`, `external-${suffix}`] },
      { statement: "INSERT INTO fdp_workspace_subscriptions (id, workspace_id, plan_id, status, provider) VALUES ($1, $2, 'plan_starter', 'active', 'manual')", parameters: [`subscription-${suffix}`, workspaceId] },
      { statement: "INSERT INTO fdp_workspace_onboarding (workspace_id, status, current_step, completed_steps_json) VALUES ($1, 'in_progress', 'team', '[\"company\"]'::jsonb)", parameters: [workspaceId] },
      { statement: "INSERT INTO fdp_workspace_usage_counters (id, workspace_id, metric, period, quantity, limit_snapshot) VALUES ($1, $2, 'companies', '2026-08', 1, 1)", parameters: [`usage-${suffix}`, workspaceId] },
      { statement: "INSERT INTO fdp_billing_events (id, workspace_id, external_event_id, event_type, object_type, object_id, summary_json, processed_at) VALUES ($1, $2, $3, 'invoice.paid', 'invoice', $4, '{\"amountPaidCents\":0}'::jsonb, now())", parameters: [`billing-event-${suffix}`, workspaceId, `evt-${suffix}`, `invoice-${suffix}`] },
      { statement: "INSERT INTO fdp_billing_invoices (id, workspace_id, subscription_id, external_invoice_id, status) VALUES ($1, $2, $3, $4, 'paid')", parameters: [`billing-invoice-${suffix}`, workspaceId, `subscription-${suffix}`, `invoice-${suffix}`] },
    ]));
  }

  const noContext = await sql.transaction(schemaQuery("SELECT id FROM fdp_cards"));
  assert.equal(noContext.at(-1).rows.length, 0, "RLS deve negar leitura sem contexto tenant");
  const noEmployeeContext = await sql.transaction(schemaQuery("SELECT id FROM fdp_employees"));
  assert.equal(noEmployeeContext.at(-1).rows.length, 0, "RLS deve negar leitura de colaboradores sem contexto tenant");
  const noOperationsContext = await sql.transaction(schemaQuery("SELECT id FROM fdp_payroll_cycles"));
  assert.equal(noOperationsContext.at(-1).rows.length, 0, "RLS deve negar leitura da operação DP sem contexto tenant");
  const noAuxiliaryContext = await sql.transaction(schemaQuery("SELECT id FROM fdp_auxiliary_executions"));
  assert.equal(noAuxiliaryContext.at(-1).rows.length, 0, "RLS deve negar leitura dos módulos auxiliares sem contexto tenant");
  const noIntegrationContext = await sql.transaction(schemaQuery("SELECT id FROM fdp_integration_sync_runs"));
  assert.equal(noIntegrationContext.at(-1).rows.length, 0, "RLS deve negar leitura do motor de integrações sem contexto tenant");
  const noSubscriptionContext = await sql.transaction(schemaQuery("SELECT id FROM fdp_workspace_subscriptions"));
  assert.equal(noSubscriptionContext.at(-1).rows.length, 0, "RLS deve negar leitura de assinaturas sem contexto tenant");

  for (const [workspaceId, userId, expectedCard] of [[workspaceA, userA, "card-a"], [workspaceB, userB, "card-b"]]) {
    const result = await sql.transaction(tenantQueries(workspaceId, userId, [
      { statement: "SELECT id FROM fdp_cards ORDER BY id" },
      { statement: "SELECT id FROM fdp_audit_events ORDER BY id" },
      { statement: "SELECT id, cpf_hash, cpf_last4 FROM fdp_employees ORDER BY id" },
      { statement: "SELECT id FROM fdp_payroll_cycles ORDER BY id" },
      { statement: "SELECT id FROM fdp_employee_movements ORDER BY id" },
      { statement: "SELECT id FROM fdp_operational_pending_items ORDER BY id" },
      { statement: "SELECT id FROM fdp_auxiliary_executions ORDER BY id" },
      { statement: "SELECT id, status FROM fdp_auxiliary_execution_revisions ORDER BY id" },
    ]));
    assert.deepEqual(result.at(-8).rows.map((row) => row.id), [expectedCard]);
    assert.equal(result.at(-7).rows.length, 1);
    assert.equal(result.at(-6).rows.length, 1);
    assert.equal(result.at(-6).rows[0].cpf_last4, "4725");
    assert.match(String(result.at(-6).rows[0].cpf_hash), /^hmac-only-/u);
    assert.equal(result.at(-5).rows.length, 1);
    assert.equal(result.at(-4).rows.length, 1);
    assert.equal(result.at(-3).rows.length, 1);
    assert.equal(result.at(-2).rows.length, 1);
    assert.equal(result.at(-1).rows.length, 1);
    assert.equal(result.at(-1).rows[0].status, "submitted");
  }

  for (const [workspaceId, userId, suffix] of [[workspaceA, userA, "a"], [workspaceB, userB, "b"]]) {
    const result = await sql.transaction(tenantQueries(workspaceId, userId, [
      { statement: "SELECT id FROM fdp_integration_credentials ORDER BY id" },
      { statement: "SELECT id FROM fdp_integration_sync_runs ORDER BY id" },
      { statement: "SELECT id FROM fdp_integration_sync_items ORDER BY id" },
      { statement: "SELECT id FROM fdp_integration_jobs ORDER BY id" },
      { statement: "SELECT id FROM fdp_integration_reconciliations ORDER BY id" },
    ]));
    assert.deepEqual(result.at(-5).rows.map((row) => row.id), [`credential-${suffix}`]);
    assert.deepEqual(result.at(-4).rows.map((row) => row.id), [`sync-run-${suffix}`]);
    assert.deepEqual(result.at(-3).rows.map((row) => row.id), [`sync-item-${suffix}`]);
    assert.deepEqual(result.at(-2).rows.map((row) => row.id), [`job-${suffix}`]);
    assert.deepEqual(result.at(-1).rows.map((row) => row.id), [`reconciliation-${suffix}`]);
  }

  for (const [workspaceId, userId, suffix] of [[workspaceA, userA, "a"], [workspaceB, userB, "b"]]) {
    const result = await sql.transaction(tenantQueries(workspaceId, userId, [
      { statement: "SELECT id FROM fdp_workspace_subscriptions" },
      { statement: "SELECT workspace_id, current_step FROM fdp_workspace_onboarding" },
      { statement: "SELECT id FROM fdp_workspace_usage_counters" },
      { statement: "SELECT id FROM fdp_billing_events" },
      { statement: "SELECT id FROM fdp_billing_invoices" },
    ]));
    assert.deepEqual(result.at(-5).rows.map((row) => row.id), [`subscription-${suffix}`]);
    assert.deepEqual(result.at(-4).rows.map((row) => row.workspace_id), [workspaceId]);
    assert.deepEqual(result.at(-3).rows.map((row) => row.id), [`usage-${suffix}`]);
    assert.deepEqual(result.at(-2).rows.map((row) => row.id), [`billing-event-${suffix}`]);
    assert.deepEqual(result.at(-1).rows.map((row) => row.id), [`billing-invoice-${suffix}`]);
  }

  const platformOverview = await sql.transaction(platformQueries(userA, [
    { statement: "SELECT id FROM fdp_workspaces WHERE id LIKE 'phase2-workspace-%' ORDER BY id" },
    { statement: "SELECT id FROM fdp_workspace_subscriptions ORDER BY id" },
  ]));
  assert.equal(platformOverview.at(-2).rows.length, 2, "Visão global deve listar os workspaces da plataforma");
  assert.equal(platformOverview.at(-1).rows.length, 2, "Contexto de plataforma deve enxergar assinaturas para suporte global");

  await assert.rejects(
    sql.transaction(tenantQueries(workspaceA, userA, [{
      statement: "INSERT INTO fdp_cards (id, workspace_id, board_id, list_id, title, position, created_by) VALUES ('cross-rls', $1, 'board-b', 'list-b', 'Cross tenant', 2000, $2)",
      parameters: [workspaceB, userA],
    }])),
    /row-level security|policy/u,
  );

  await assert.rejects(
    sql.transaction(tenantQueries(workspaceA, userA, [{
      statement: "INSERT INTO fdp_employees (id, workspace_id, company_id, registration_number, full_name, admission_date, created_by, updated_by) VALUES ('cross-employee', $1, 'company-b', 'CROSS', 'Cross tenant', '2026-08-01', $2, $2)",
      parameters: [workspaceA, userA],
    }])),
    /foreign key|violates/u,
  );

  await assert.rejects(
    sql.transaction(tenantQueries(workspaceA, userA, [{
      statement: "INSERT INTO fdp_cards (id, workspace_id, board_id, list_id, title, position, created_by) VALUES ('cross-fk', $1, 'board-b', 'list-b', 'Cross tenant', 2000, $2)",
      parameters: [workspaceA, userA],
    }])),
    /foreign key|violates/u,
  );

  await assert.rejects(
    sql.transaction(tenantQueries(workspaceA, userA, [{
      statement: "INSERT INTO fdp_payroll_cycles (id, workspace_id, company_id, competence, created_by) VALUES ('cross-cycle', $1, 'company-b', '2026-09', $2)",
      parameters: [workspaceA, userA],
    }])),
    /foreign key|violates/u,
  );

  await assert.rejects(
    sql.transaction(tenantQueries(workspaceA, userA, [{
      statement: "UPDATE fdp_process_versions SET configuration_json = '{\"steps\":[]}'::jsonb WHERE id = 'process-version-a'",
    }])),
    /published process versions are immutable/u,
  );

  await assert.rejects(
    sql.transaction(tenantQueries(workspaceA, userA, [{
      statement: "INSERT INTO fdp_auxiliary_executions (id, workspace_id, company_id, payroll_cycle_id, module_type, reference_code, title, created_by) VALUES ('cross-auxiliary', $1, 'company-b', 'cycle-a', 'benefits', 'CROSS-AUX', 'Cross tenant', $2)",
      parameters: [workspaceA, userA],
    }])),
    /foreign key|violates/u,
  );

  await assert.rejects(
    sql.transaction(tenantQueries(workspaceA, userA, [{
      statement: "UPDATE fdp_auxiliary_execution_revisions SET input_json = '{\"participantsCount\":99}'::jsonb WHERE id = 'aux-revision-a'",
    }])),
    /submitted auxiliary revision is immutable/u,
  );

  await assert.rejects(
    sql.transaction(tenantQueries(workspaceA, userA, [{
      statement: "INSERT INTO fdp_integration_sync_runs (id, workspace_id, integration_id, mapping_id, idempotency_key) VALUES ('cross-integration-run', $1, 'integration-b', 'mapping-a', 'cross-tenant')",
      parameters: [workspaceA],
    }])),
    /foreign key|violates/u,
  );

  await assert.rejects(
    sql.transaction(tenantQueries(workspaceA, userA, [{ statement: "UPDATE fdp_integration_credentials SET encrypted_value = 'tampered' WHERE id = 'credential-a'" }])),
    /sealed integration credential is immutable/u,
  );

  await assert.rejects(
    sql.transaction(tenantQueries(workspaceA, userA, [{ statement: "UPDATE fdp_integration_mappings SET mapping_json = '{\"fields\":[]}'::jsonb WHERE id = 'mapping-a'" }])),
    /published integration mapping is immutable/u,
  );

  await assert.rejects(
    sql.transaction(tenantQueries(workspaceA, userA, [{ statement: "UPDATE fdp_audit_events SET action = 'tampered' WHERE id = 'audit-a'" }])),
    /append-only/u,
  );

  await assert.rejects(
    sql.transaction(tenantQueries(workspaceA, userA, [{ statement: "UPDATE fdp_billing_events SET status = 'ignored' WHERE id = 'billing-event-a'" }])),
    /append-only/u,
  );

  console.log(`Ensaio das Fases 2 a 7 aprovado em ${migrationFiles.length} migrations: RLS, FKs compostas, operação DP, módulos auxiliares, integrações, SaaS multi-workspace, cobrança idempotente e auditoria append-only.`);
} finally {
  await sql.query(`DROP SCHEMA "${schema}" CASCADE`, []);
  if (roleCreated) {
    await sql.query(`REVOKE "${testRole}" FROM CURRENT_USER`, []);
    await sql.query(`DROP ROLE "${testRole}"`, []);
  }
}
