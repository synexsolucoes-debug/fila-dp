/**
 * Semente da carteira do DP para um workspace (DP Operacional, Fase 1).
 *
 * Uso:
 *   DATABASE_URL=postgres://... node scripts/seed-dp-carteira.mjs \
 *     --workspace <id> --seed opyt \
 *     --pessoa Odete=odete@empresa.com.br --pessoa Rian=rian@empresa.com.br
 *
 * Aplica também as rotinas recorrentes (Fase 2) e as regras de corte (Fase 3)
 * do mesmo arquivo de semente.
 *
 * Idempotente: empresa existente (pelo CODEMP, ou pelo CNPJ, ou pelo nome
 * quando não há nenhum dos dois) recebe só a situação do DP; a carteira só é
 * criada para empresa que ainda não tem vigência aberta — nunca reescreve uma
 * troca feita pela tela. `--dry-run` mostra o que faria sem gravar.
 *
 * As pessoas precisam já ser membros (admin ou member) do workspace.
 */
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const people = new Map(args.flatMap((value, index) => args[index - 1] === "--pessoa" ? [value.split("=")] : []));
const workspaceId = option("workspace");
const seedName = option("seed") ?? "opyt";
const dryRun = args.includes("--dry-run");

if (!workspaceId) throw new Error("Informe --workspace <id>.");
if (!/^[a-z0-9-]+$/u.test(seedName)) throw new Error("--seed inválido.");
const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!databaseUrl?.startsWith("postgres")) throw new Error("Defina DATABASE_URL.");

const { companies, recurringTemplates = [], cutoffRules = [] } = await import(`./seeds/${seedName}-carteira.mjs`);
const digits = (value) => String(value ?? "").replace(/\D/gu, "");
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const { default: pg } = await import("pg");
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

try {
  await client.query("BEGIN");
  // RLS forçada: sem o contexto do tenant, toda escrita é recusada.
  await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);

  const owner = await client.query("SELECT owner_user_id FROM fdp_workspaces WHERE id = $1", [workspaceId]);
  if (!owner.rowCount) throw new Error(`Workspace ${workspaceId} não encontrado.`);
  const actor = String(owner.rows[0].owner_user_id);

  const userIds = new Map();
  for (const [alias, email] of people) {
    const found = await client.query(`SELECT u.id FROM fdp_users u JOIN fdp_workspace_members wm ON wm.user_id = u.id
      WHERE wm.workspace_id = $1 AND lower(u.email) = lower($2) AND wm.role IN ('admin', 'member')`, [workspaceId, email]);
    if (!found.rowCount) throw new Error(`${alias} (${email}) não é membro ativo do workspace.`);
    userIds.set(alias, String(found.rows[0].id));
  }

  const existing = (await client.query("SELECT id, external_code, tax_id, legal_name FROM fdp_companies WHERE workspace_id = $1", [workspaceId])).rows;
  const report = [];
  for (const company of companies) {
    const match = existing.find((row) => company.code && row.external_code === company.code)
      ?? existing.find((row) => company.taxId && digits(row.tax_id) === digits(company.taxId))
      ?? existing.find((row) => !company.code && !company.taxId && row.legal_name.toUpperCase() === company.name.toUpperCase());
    let companyId = match?.id;
    if (companyId) {
      await client.query(`UPDATE fdp_companies SET dp_status = $1,
          external_code = CASE WHEN external_code = '' THEN $2 ELSE external_code END,
          tax_id = CASE WHEN tax_id = '' THEN $3 ELSE tax_id END, updated_at = now()
        WHERE workspace_id = $4 AND id = $5`, [company.dpStatus, company.code, company.taxId, workspaceId, companyId]);
    } else {
      companyId = randomUUID();
      await client.query(`INSERT INTO fdp_companies (id, workspace_id, legal_name, trade_name, tax_id, external_code, dp_status)
        VALUES ($1, $2, $3, $3, $4, $5, $6)`, [companyId, workspaceId, company.name, company.taxId, company.code, company.dpStatus]);
    }

    let portfolio = "sem carteira";
    if (company.holder) {
      const holder = userIds.get(company.holder);
      const backup = company.backup ? userIds.get(company.backup) : null;
      if (!holder || (company.backup && !backup)) throw new Error(`Informe --pessoa ${company.holder}=<e-mail>${company.backup ? ` e --pessoa ${company.backup}=<e-mail>` : ""}.`);
      const open = await client.query("SELECT 1 FROM fdp_company_portfolio WHERE workspace_id = $1 AND company_id = $2 AND valid_to IS NULL", [workspaceId, companyId]);
      if (open.rowCount) {
        portfolio = "carteira já existente (mantida)";
      } else {
        await client.query(`INSERT INTO fdp_company_portfolio (id, workspace_id, company_id, holder_user_id, backup_user_id, valid_from, created_by)
          VALUES ($1, $2, $3, $4, $5, $6::date, $7)`, [randomUUID(), workspaceId, companyId, holder, backup, today, actor]);
        await client.query(`INSERT INTO fdp_audit_events (id, workspace_id, actor_type, actor_email, action, outcome, entity_type, entity_id, after_json, metadata_json)
          VALUES ($1, $2, 'system', 'SYSTEM', 'portfolio.assigned', 'success', 'company_portfolio', $3, $4::jsonb, $5::jsonb)`,
          [randomUUID(), workspaceId, companyId, JSON.stringify({ holderUserId: holder, backupUserId: backup, validFrom: today }),
            JSON.stringify({ scope: "company", companyId, source: `seed:${seedName}` })]);
        portfolio = `${company.holder} / ${company.backup ?? "sem backup"}`;
      }
    }
    report.push({ CODEMP: company.code || "—", empresa: company.name, situacao: company.dpStatus, origem: match ? "existente" : "criada", carteira: portfolio });
  }
  console.table(report);

  // Rotinas e regras de corte (Fases 2 e 3): criadas se o código ainda não
  // existe; o que foi ajustado pela tela fica como está.
  const codeToId = new Map((await client.query("SELECT id, external_code FROM fdp_companies WHERE workspace_id = $1", [workspaceId])).rows
    .filter((row) => row.external_code).map((row) => [String(row.external_code), String(row.id)]));
  let templatesCreated = 0;
  for (const template of recurringTemplates) {
    const companyIds = template.companies ? template.companies.map((code) => codeToId.get(code)).filter(Boolean) : null;
    const inserted = await client.query(`INSERT INTO fdp_recurring_templates
      (id, workspace_id, code, name, description, frequency, day_start, day_end, weekday, scope, company_ids, process_type, list_week_movements, created_by)
      VALUES ($1, $2, $3, $4, '', $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13) ON CONFLICT (workspace_id, code) DO NOTHING`,
      [randomUUID(), workspaceId, template.code, template.name, template.frequency, template.dayStart ?? 1, template.dayEnd ?? template.dayStart ?? 1,
        template.frequency === "weekly" ? template.weekday : null, template.scope, companyIds ? JSON.stringify(companyIds) : null,
        template.processType, Boolean(template.listWeekMovements), actor]);
    templatesCreated += inserted.rowCount ?? 0;
  }
  let rulesCreated = 0;
  for (const rule of cutoffRules) {
    const inserted = await client.query(`INSERT INTO fdp_cutoff_rules
      (id, workspace_id, code, name, process_types, kind, value, month_day_limit, description, status, created_by, updated_by)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $11) ON CONFLICT (workspace_id, code) DO NOTHING`,
      [randomUUID(), workspaceId, rule.code, rule.name, JSON.stringify(rule.processTypes), rule.kind, rule.value, rule.monthDayLimit, rule.description, rule.status, actor]);
    rulesCreated += inserted.rowCount ?? 0;
  }
  console.log(`Rotinas criadas: ${templatesCreated} de ${recurringTemplates.length}. Regras de corte criadas: ${rulesCreated} de ${cutoffRules.length}.`);
  await client.query(dryRun ? "ROLLBACK" : "COMMIT");
  console.log(dryRun ? "Simulação: nada foi gravado." : "Carteira aplicada.");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await client.end();
}
