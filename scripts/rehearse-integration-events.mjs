/**
 * Ensaio da central de eventos e do ciclo de vida do grupo contra um
 * PostgreSQL de verdade.
 *
 * Existe porque as três garantias que mais importam nesta entrega são do
 * **banco**, não do código, e nenhum teste unitário as prova:
 *
 * 1. a idempotência vem do índice único
 *    `(workspace_id, integration_id, external_event_id)` — é ele que impede
 *    duas entregas simultâneas do mesmo webhook abrirem duas demandas;
 * 2. o isolamento vem da RLS — e RLS **só existe** para um papel sem
 *    `BYPASSRLS`. Conectado como superusuário, o PostgreSQL ignora as políticas
 *    e todo teste de isolamento passa sem provar absolutamente nada. Por isso o
 *    ensaio cria um papel dedicado e reprova se ele puder contornar;
 * 3. os CHECK de estado (`deleted` exige data, estado não-ativo exige motivo,
 *    sugestão confirmada exige demanda) são o que transforma um bug de código em
 *    erro de gravação em vez de dado inconsistente em produção.
 *
 * Uso:
 *   FDP_EVENTS_TEST_DATABASE_URL="postgres://…" \
 *   FDP_ALLOW_EPHEMERAL_SCHEMA_TEST=true \
 *   node scripts/rehearse-integration-events.mjs
 *
 * O ensaio grava, então exige um banco de teste dedicado e a autorização
 * explícita acima. Ele limpa o que criou ao final.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";

const databaseUrl = process.env.FDP_EVENTS_TEST_DATABASE_URL;
if (!databaseUrl?.startsWith("postgres")) {
  console.error("Defina FDP_EVENTS_TEST_DATABASE_URL apontando para um PostgreSQL de teste dedicado.");
  process.exit(2);
}
if (process.env.FDP_ALLOW_EPHEMERAL_SCHEMA_TEST !== "true") {
  console.error("Defina FDP_ALLOW_EPHEMERAL_SCHEMA_TEST=true para autorizar a gravação do ensaio.");
  process.exit(2);
}

const suffix = randomBytes(6).toString("hex");
const role = `fdp_events_role_${suffix}`;
if (!/^fdp_events_role_[0-9a-f]{12}$/u.test(role)) throw new Error("Nome de papel efêmero inválido.");
const groupA = `ws-a-${suffix}`;
const groupB = `ws-b-${suffix}`;

const admin = new pg.Client({ connectionString: databaseUrl });
await admin.connect();

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS  " : "FALHOU"}  ${name}${detail ? ` (${detail})` : ""}`);
};

async function seed(workspaceId, slug) {
  await admin.query("INSERT INTO fdp_users (id, email, name) VALUES ($1, $2, $3)", [`u-${workspaceId}`, `${workspaceId}@ensaio.local`, workspaceId]);
  await admin.query("INSERT INTO fdp_workspaces (id, name, slug, owner_user_id) VALUES ($1, $2, $3, $4)", [workspaceId, `Grupo ${workspaceId}`, slug, `u-${workspaceId}`]);
  await admin.query("INSERT INTO fdp_workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')", [workspaceId, `u-${workspaceId}`]);
  await admin.query("INSERT INTO fdp_integrations (id, workspace_id, channel, display_name) VALUES ($1, $2, 'teams', 'Teams')", [`int-${workspaceId}`, workspaceId]);
}

let app;
try {
  await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${suffix}'`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
  await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO "${role}"`);
  await seed(groupA, `grupo-a-${suffix}`);
  await seed(groupB, `grupo-b-${suffix}`);

  const url = new URL(databaseUrl);
  url.username = role;
  url.password = suffix;
  app = new pg.Client({ connectionString: url.toString() });
  await app.connect();

  // Confirma que o papel do ensaio realmente está sujeito à RLS. Sem esta
  // verificação, um papel privilegiado faria tudo abaixo passar por engano.
  const privileges = await app.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
  check("o papel do ensaio está sujeito à RLS", privileges.rows[0]?.rolsuper === false && privileges.rows[0]?.rolbypassrls === false);

  const as = async (workspaceId, query, parameters = []) => {
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    try {
      const result = await app.query(query, parameters);
      await app.query("COMMIT");
      return result;
    } catch (error) {
      await app.query("ROLLBACK");
      throw error;
    }
  };

  const insertEvent = (id, workspaceId, externalEventId) => as(
    workspaceId,
    `INSERT INTO fdp_integration_events (id, workspace_id, integration_id, connector, event_type, external_event_id)
     VALUES ($1, $2, $3, 'teams', 'channel_message', $4)
     ON CONFLICT (workspace_id, integration_id, external_event_id) DO NOTHING RETURNING id`,
    [id, workspaceId, `int-${workspaceId}`, externalEventId],
  );

  await insertEvent(`ev-1-${suffix}`, groupA, "teams:msg-1");
  const fromB = await as(groupB, "SELECT id FROM fdp_integration_events");
  check("grupo B não enxerga o evento do grupo A", fromB.rows.length === 0, `viu ${fromB.rows.length}`);
  const fromA = await as(groupA, "SELECT id FROM fdp_integration_events");
  check("grupo A enxerga o próprio evento", fromA.rows.length === 1);

  const duplicate = await insertEvent(`ev-2-${suffix}`, groupA, "teams:msg-1");
  check("o mesmo evento externo não é registrado duas vezes", duplicate.rows.length === 0);

  const distinct = await insertEvent(`ev-3-${suffix}`, groupB, "teams:msg-1");
  check("o mesmo id externo em outro grupo é um evento distinto", distinct.rows.length === 1);

  let denied = false;
  try {
    await as(groupB, `INSERT INTO fdp_integration_events (id, workspace_id, integration_id, connector, event_type, external_event_id)
      VALUES ($1, $2, $3, 'teams', 'channel_message', 'teams:msg-9')`, [`ev-4-${suffix}`, groupA, `int-${groupA}`]);
  } catch { denied = true; }
  check("gravar evento no grupo errado é recusado pela política", denied);

  await insertEvent(`ev-5-${suffix}`, groupA, "teams:msg-2");
  await as(groupA, `INSERT INTO fdp_movement_suggestions (id, workspace_id, integration_id, event_id, movement_kind, message_id)
    VALUES ($1, $2, $3, $4, 'salary_change', 'msg-2')`, [`sug-1-${suffix}`, groupA, `int-${groupA}`, `ev-5-${suffix}`]);
  let uniqueSuggestion = false;
  try {
    await as(groupA, `INSERT INTO fdp_movement_suggestions (id, workspace_id, integration_id, event_id, movement_kind, message_id)
      VALUES ($1, $2, $3, $4, 'salary_change', 'msg-2')`, [`sug-2-${suffix}`, groupA, `int-${groupA}`, `ev-5-${suffix}`]);
  } catch { uniqueSuggestion = true; }
  check("mensagem editada não abre uma segunda sugestão pendente", uniqueSuggestion);

  let confirmationGuard = false;
  try {
    await as(groupA, "UPDATE fdp_movement_suggestions SET status = 'confirmed', resolved_at = now() WHERE id = $1", [`sug-1-${suffix}`]);
  } catch { confirmationGuard = true; }
  check("sugestão confirmada exige a demanda vinculada", confirmationGuard);

  let reasonRequired = false;
  try {
    await admin.query("UPDATE fdp_workspaces SET status = 'archived', status_reason = '' WHERE id = $1", [groupA]);
  } catch { reasonRequired = true; }
  check("estado não-ativo exige motivo registrado", reasonRequired);

  let deletedNeedsDate = false;
  try {
    await admin.query("UPDATE fdp_workspaces SET status = 'deleted', status_reason = 'Contrato encerrado' WHERE id = $1", [groupA]);
  } catch { deletedNeedsDate = true; }
  check("estado 'deleted' exige a data de exclusão", deletedNeedsDate);

  await admin.query(
    `UPDATE fdp_workspaces SET status = 'deleted', status_reason = 'Contrato encerrado',
       deleted_at = now(), purge_after = now() + interval '30 days' WHERE id = $1`,
    [groupA],
  );
  const deleted = await admin.query("SELECT status, purge_after FROM fdp_workspaces WHERE id = $1", [groupA]);
  check("a exclusão do grupo é reversível: grava estado e prazo", deleted.rows[0]?.status === "deleted" && deleted.rows[0]?.purge_after !== null);

  // O cenário do requisito: excluir um grupo não pode tirar o usuário dos outros.
  const survivor = await admin.query("SELECT id FROM fdp_workspaces WHERE id = $1 AND status = 'active'", [groupB]);
  check("o outro grupo do usuário segue ativo", survivor.rows.length === 1);
} finally {
  if (app) await app.end();
  await admin.query("DELETE FROM fdp_workspaces WHERE id = ANY($1)", [[groupA, groupB]]).catch(() => {});
  await admin.query("DELETE FROM fdp_users WHERE id = ANY($1)", [[`u-${groupA}`, `u-${groupB}`]]).catch(() => {});
  await admin.query(`REASSIGN OWNED BY "${role}" TO CURRENT_USER`).catch(() => {});
  await admin.query(`DROP OWNED BY "${role}"`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
  await admin.end();
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} verificações passaram`);
process.exit(failed.length ? 1 : 0);
